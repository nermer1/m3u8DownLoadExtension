// Offscreen Downloader Engine
const activeTasks = {};

// Handle incoming messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, taskId, url, title, type, resolution, downloadId, errorMsg } = message;

  if (action === 'START_DOWNLOAD') {
    startTask(taskId, url, title, type, resolution);
    sendResponse({ success: true });
  } else if (action === 'PAUSE_DOWNLOAD') {
    pauseTask(taskId);
    sendResponse({ success: true });
  } else if (action === 'CANCEL_DOWNLOAD') {
    cancelTask(taskId);
    sendResponse({ success: true });
  } else if (action === 'DOWNLOAD_SUCCESS_CLEANUP') {
    const task = activeTasks[taskId];
    if (task) {
      cleanupTask(task);
      delete activeTasks[taskId];
    }
    checkAndCloseOffscreen();
    sendResponse({ success: true });
  } else if (action === 'DOWNLOAD_FAILED_CLEANUP') {
    const task = activeTasks[taskId];
    if (task) {
      cleanupTask(task);
      delete activeTasks[taskId];
    }
    checkAndCloseOffscreen();
    sendResponse({ success: true });
  }
});

// Start a download task
async function startTask(taskId, url, title, type, resolution) {
  let task = activeTasks[taskId];

  if (!task) {
    task = {
      id: taskId,
      url: url,
      title: title,
      type: type,
      resolution: resolution,
      state: 'parsing',
      downloadedCount: 0,
      totalSegments: 0,
      segmentUrls: [],
      downloadedBuffers: [],
      activeIndices: new Set(),
      abortController: null,
      threads: 5,
      startTime: 0,
      speedTracker: { bytes: 0, lastTime: 0, currentSpeed: 0 },
      speedInterval: null,
      isSequence: false,
      seqPrefix: '',
      seqStartVal: 0,
      seqPadding: 0,
      seqSuffix: '',
      seqBasePath: '',
      nextIndexToSpawn: 0,
      endIndex: -1,
      downloadedBuffersMap: {}
    };
    activeTasks[taskId] = task;
  } else if (task.state === 'paused') {
    // Resume task
    task.state = 'downloading';
    task.abortController = new AbortController();
    task.startTime = Date.now() - (task.elapsedTime || 0);
    startSpeedInterval(task);
    runTaskQueue(task);
    broadcastProgress(task);
    return;
  } else {
    return;
  }

  broadcastProgress(task);

  try {
    let targetUrl = url;
    
    // Parse M3U8 list recursively to get segments
    if (type === 'm3u8') {
      task.segmentUrls = await fetchAndParseM3u8Recursively(task, targetUrl);
      task.totalSegments = task.segmentUrls.length;
      if (task.totalSegments === 0) {
        throw new Error('스트림에 유효한 비디오 조각이 없습니다.');
      }
      task.downloadedBuffers = new Array(task.totalSegments).fill(null);
    } else {
      // TS segment sequence mode: analyze sequence pattern in TS filename
      const lastSlash = targetUrl.lastIndexOf('/');
      const basePath = targetUrl.substring(0, lastSlash + 1);
      const filename = targetUrl.substring(lastSlash + 1);
      const numMatch = filename.match(/(\d+)(?=[^\d]*$)/);

      if (!numMatch) {
        // Single TS file
        task.segmentUrls = [targetUrl];
        task.totalSegments = 1;
        task.downloadedBuffers = [null];
      } else {
        // Set up sequence task
        task.isSequence = true;
        task.seqPrefix = filename.substring(0, numMatch.index);
        task.seqStartVal = parseInt(numMatch[1], 10);
        task.seqPadding = numMatch[1].length;
        task.seqSuffix = filename.substring(numMatch.index + numMatch[1].length);
        task.seqBasePath = basePath;
        task.nextIndexToSpawn = 0;
        task.endIndex = -1;
        task.downloadedBuffersMap = {};
        task.totalSegments = 0;

        // Probe starting value (try starting from 0 or 1 if startVal > 1)
        if (task.seqStartVal > 1) {
          try {
            const probeUrl0 = getSequenceUrl(task, 0 - task.seqStartVal);
            if (await urlExists(probeUrl0)) {
              task.seqStartVal = 0;
            } else {
              const probeUrl1 = getSequenceUrl(task, 1 - task.seqStartVal);
              if (await urlExists(probeUrl1)) {
                task.seqStartVal = 1;
              }
            }
          } catch(e) {}
        }
      }
    }

    task.state = 'downloading';
    task.abortController = new AbortController();
    task.startTime = Date.now();

    startSpeedInterval(task);
    runTaskQueue(task);
    broadcastProgress(task);

  } catch (err) {
    task.state = 'error';
    task.errorMsg = err.message;
    broadcastProgress(task);
    cleanupTask(task);
  }
}

// Probe starting sequence helper
function getSequenceUrl(task, idx) {
  const val = task.seqStartVal + idx;
  const valStr = String(val < 0 ? 0 : val).padStart(task.seqPadding, '0');
  return task.seqBasePath + task.seqPrefix + valStr + task.seqSuffix;
}

async function urlExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch(e) {
    try {
      const res = await fetch(url);
      return res.ok;
    } catch(err) {
      return false;
    }
  }
}

// Pause a task
function pauseTask(taskId) {
  const task = activeTasks[taskId];
  if (task && task.state === 'downloading') {
    task.state = 'paused';
    task.elapsedTime = Date.now() - task.startTime;
    if (task.abortController) {
      task.abortController.abort();
    }
    stopSpeedInterval(task);
    broadcastProgress(task);
  }
}

// Cancel a task
function cancelTask(taskId) {
  const task = activeTasks[taskId];
  if (task) {
    if (task.abortController) {
      task.abortController.abort();
    }
    stopSpeedInterval(task);
    cleanupTask(task);
    delete activeTasks[taskId];
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_CANCELLED', taskId }, () => {
      if (chrome.runtime.lastError) { /* ignore closed popup errors */ }
    });
  }
}

// HLS .m3u8 Recursive Parser (runs in offscreen DOM space)
async function fetchAndParseM3u8Recursively(task, url, depth = 0) {
  if (depth > 5) {
    throw new Error('M3U8 호출 깊이가 너무 깊습니다.');
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`재생목록 로드 실패 (HTTP ${response.status})`);
  }
  
  const text = await response.text();
  if (!text.trim().startsWith('#EXTM3U')) {
    throw new Error('올바른 M3U8 형식의 파일이 아닙니다. 토큰이 만료되었거나 접근이 차단되었을 수 있습니다.');
  }
  const lines = text.split('\n');
  const segmentUrls = [];
  const masterPlaylists = [];
  const baseUrl = url;
  
  let currentKey = null;
  let currentIv = null;
  let mediaSequence = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      // DRM (SAMPLE-AES, Widevine/PlayReady/FairPlay key formats) is not supported
      const method = (line.match(/METHOD=([A-Z0-9-]+)/) || [])[1] || '';
      const keyFormat = (line.match(/KEYFORMAT="([^"]+)"/) || [])[1] || 'identity';
      if ((method !== 'NONE' && method !== 'AES-128') || keyFormat !== 'identity') {
        throw new Error('DRM 보호 영상은 지원하지 않습니다.');
      }
      if (line.startsWith('#EXT-X-SESSION-KEY:')) continue;
      if (method === 'AES-128') {
        const uriMatch = line.match(/URI="([^"]+)"/);
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);
        if (uriMatch) {
          const keyUrl = resolveUrl(baseUrl, uriMatch[1]);
          try {
            const keyRes = await fetch(keyUrl);
            const keyBuffer = await keyRes.arrayBuffer();
            currentKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
          } catch(e) {
            console.error("Failed to fetch AES key:", e);
          }
        }
        if (ivMatch) {
          const hex = ivMatch[1].padStart(32, '0');
          currentIv = new Uint8Array(16);
          for (let j = 0; j < 16; j++) {
            currentIv[j] = parseInt(hex.slice(j*2, j*2+2), 16);
          }
        } else {
          currentIv = null;
        }
      } else if (line.includes('METHOD=NONE')) {
        currentKey = null;
        currentIv = null;
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      let bandwidth = 0;
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      if (bwMatch) bandwidth = parseInt(bwMatch[1]);

      let res = '';
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      if (resMatch) res = resMatch[1];

      let nextLine = '';
      for (let j = i + 1; j < lines.length; j++) {
        const nl = lines[j].trim();
        if (nl && !nl.startsWith('#')) {
          nextLine = nl;
          break;
        }
      }
      if (nextLine) {
        masterPlaylists.push({
          url: resolveUrl(baseUrl, nextLine),
          bandwidth,
          resolution: res
        });
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const match = line.match(/URI="([^"]+)"/);
      if (match) {
        segmentUrls.push({ url: resolveUrl(baseUrl, match[1]), key: currentKey, iv: currentIv, seq: mediaSequence });
        task.isFmp4 = true;
      }
    } else if (!line.startsWith('#')) {
      let iv = currentIv;
      if (currentKey && !iv) {
        iv = new Uint8Array(16);
        const view = new DataView(iv.buffer);
        view.setUint32(12, mediaSequence, false);
      }
      segmentUrls.push({ url: resolveUrl(baseUrl, line), key: currentKey, iv: iv, seq: mediaSequence });
      mediaSequence++;
    }
  }

  if (masterPlaylists.length > 0) {
    masterPlaylists.sort((a, b) => b.bandwidth - a.bandwidth);
    let selectedPlaylist = masterPlaylists[0];

    if (task.resolution && task.resolution !== 'best') {
      const targetHeight = task.resolution.replace('p', '');
      const match = masterPlaylists.find(p => {
        const hMatch = p.resolution.split('x')[1];
        if (hMatch && hMatch === targetHeight) return true;
        return p.resolution.includes(task.resolution) || p.resolution.includes(targetHeight) || p.url.includes(task.resolution) || p.url.includes(targetHeight);
      });
      if (match) {
        selectedPlaylist = match;
      }
    }
    return fetchAndParseM3u8Recursively(task, selectedPlaylist.url, depth + 1);
  }
  return segmentUrls;
}

// Queue downloader
async function runTaskQueue(task) {
  const workers = [];
  
  if (task.isSequence) {
    for (let i = 0; i < task.threads; i++) {
      workers.push(downloadSequenceWorker(task));
    }
    await Promise.all(workers);

    if (task.state === 'downloading') {
      task.state = 'merged';
      broadcastProgress(task);
      stopSpeedInterval(task);
      
      try {
        const end = task.endIndex === -1 ? task.nextIndexToSpawn : task.endIndex;
        task.downloadedBuffers = [];
        for (let i = 0; i < end; i++) {
          if (task.downloadedBuffersMap[i]) {
            task.downloadedBuffers.push(task.downloadedBuffersMap[i]);
          }
        }
        task.totalSegments = task.downloadedBuffers.length;
        mergeAndSaveTask(task);
      } catch(err) {
        task.state = 'error';
        task.errorMsg = `병합 실패: ${err.message}`;
        broadcastProgress(task);
      }
    }
  } else {
    for (let i = 0; i < task.threads; i++) {
      workers.push(downloadWorker(task));
    }
    await Promise.all(workers);

    if (task.state === 'downloading' && task.downloadedCount === task.totalSegments) {
      task.state = 'merged';
      broadcastProgress(task);
      stopSpeedInterval(task);
      
      try {
        mergeAndSaveTask(task);
      } catch(err) {
        task.state = 'error';
        task.errorMsg = `병합 실패: ${err.message}`;
        broadcastProgress(task);
      }
    }
  }
}

// Single download worker for HLS / Static list
async function downloadWorker(task) {
  while (task.state === 'downloading') {
    const nextIdx = getNextIndex(task);
    if (nextIdx === -1) break;

    task.activeIndices.add(nextIdx);
    let success = false;
    let retries = 3;

    while (retries > 0 && !success && task.state === 'downloading') {
      try {
        const seg = task.segmentUrls[nextIdx];
        const segUrl = typeof seg === 'string' ? seg : seg.url;
        const segKey = typeof seg === 'string' ? null : seg.key;
        const segIv = typeof seg === 'string' ? null : seg.iv;
        const buffer = await fetchSegment(task, segUrl, task.abortController.signal, segKey, segIv);
        task.downloadedBuffers[nextIdx] = buffer;
        success = true;
        task.downloadedCount++;
        broadcastProgress(task);
      } catch (err) {
        if (err.name === 'AbortError') break;
        retries--;
        if (retries === 0) {
          task.state = 'error';
          task.errorMsg = `조각 다운로드 실패 (${nextIdx + 1}/${task.totalSegments}): ${err.message}`;
          broadcastProgress(task);
          if (task.abortController) {
            task.abortController.abort();
          }
          break;
        }
      }
    }
    task.activeIndices.delete(nextIdx);
  }
}

// Speculative worker for numbered TS sequences
async function downloadSequenceWorker(task) {
  while (task.state === 'downloading') {
    if (task.endIndex !== -1) break;

    const idx = task.nextIndexToSpawn++;
    task.activeIndices.add(idx);

    let success = false;
    let retries = 3;
    let is404 = false;
    const url = getSequenceUrl(task, idx);

    while (retries > 0 && !success && task.state === 'downloading') {
      try {
        const response = await fetch(url, { signal: task.abortController.signal });
        if (response.status === 404) {
          is404 = true;
          break;
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          receivedLength += value.length;
          task.speedTracker.bytes += value.length;
        }

        const combined = new Uint8Array(receivedLength);
        let position = 0;
        for (let chunk of chunks) {
          combined.set(chunk, position);
          position += chunk.length;
        }

        task.downloadedBuffersMap[idx] = combined.buffer;
        success = true;
        task.downloadedCount++;

        if (task.endIndex === -1) {
          task.totalSegments = Math.max(task.totalSegments, idx + 1);
        }
        broadcastProgress(task);

      } catch (err) {
        if (err.name === 'AbortError') break;
        retries--;
        if (retries === 0) {
          is404 = true; // treat as end of sequence if permanently failed
        }
      }
    }

    task.activeIndices.delete(idx);

    if (is404) {
      if (task.endIndex === -1 || idx < task.endIndex) {
        task.endIndex = idx;
        task.totalSegments = idx;
      }
      broadcastProgress(task);
      break;
    }
  }
}

function getNextIndex(task) {
  for (let i = 0; i < task.totalSegments; i++) {
    if (task.downloadedBuffers[i] === null && !task.activeIndices.has(i)) {
      return i;
    }
  }
  return -1;
}

// Fetch segment chunk and optionally decrypt
async function fetchSegment(task, url, signal, key = null, iv = null) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    receivedLength += value.length;
    task.speedTracker.bytes += value.length;
  }

  const combined = new Uint8Array(receivedLength);
  let position = 0;
  for (let chunk of chunks) {
    combined.set(chunk, position);
    position += chunk.length;
  }
  
  if (key && iv) {
    try {
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, combined.buffer);
      return decrypted;
    } catch (e) {
      console.error("AES Decryption failed for segment:", e);
      throw new Error("AES 복호화 실패");
    }
  }
  
  return combined.buffer;
}

// Merge buffers and download
// Merge buffers and download
function mergeAndSaveTask(task) {
  const validChunks = task.downloadedBuffers.filter(buf => buf !== null);
  
  let finalBlob;
  let defaultExt = task.isFmp4 ? '.mp4' : '.mp4';
  
  // Use mux.js to properly remux TS into a valid MP4 container so it opens in all players
  if (!task.isFmp4 && typeof muxjs !== 'undefined') {
    try {
      const transmuxer = new muxjs.mp4.Transmuxer();
      const remuxedChunks = [];
      let initSegment = null;
      
      transmuxer.on('data', (segment) => {
        if (segment.initSegment && !initSegment) {
          initSegment = segment.initSegment;
        }
        if (segment.data) {
          remuxedChunks.push(segment.data);
        }
      });
      
      // Push chunks segment-by-segment
      for (let chunk of validChunks) {
        transmuxer.push(new Uint8Array(chunk));
      }
      // Flush once at the end to trigger final data events
      transmuxer.flush();
      
      if (remuxedChunks.length > 0) {
        // Concatenate MP4 chunks including initSegment
        let totalMp4Length = initSegment ? initSegment.byteLength : 0;
        for (let chunk of remuxedChunks) {
          totalMp4Length += chunk.byteLength;
        }
        
        const mp4Bytes = new Uint8Array(totalMp4Length);
        let mp4Offset = 0;
        
        if (initSegment) {
          mp4Bytes.set(initSegment, mp4Offset);
          mp4Offset += initSegment.byteLength;
        }
        
        for (let chunk of remuxedChunks) {
          mp4Bytes.set(new Uint8Array(chunk), mp4Offset);
          mp4Offset += chunk.byteLength;
        }
        
        finalBlob = new Blob([mp4Bytes], { type: 'video/mp4' });
      } else {
        finalBlob = new Blob(validChunks, { type: 'video/mp2t' });
        defaultExt = '.ts';
      }
    } catch (err) {
      console.error("Mux.js remuxing failed:", err);
      finalBlob = new Blob(validChunks, { type: 'video/mp2t' });
      defaultExt = '.ts';
    }
  } else {
    finalBlob = new Blob(validChunks, { type: task.isFmp4 ? 'video/mp4' : 'video/mp2t' });
    if (!task.isFmp4) defaultExt = '.ts';
  }

  task.state = 'saving';
  broadcastProgress(task);

  const blobUrl = URL.createObjectURL(finalBlob);
  const filename = getCleanFilename(task.title, defaultExt);

  // Download directly within the offscreen document using an anchor tag
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  
  // Cleanup anchor tag, but do not revoke blobUrl immediately as it needs time to download
  setTimeout(() => {
    document.body.removeChild(a);
  }, 1000);

  // Tell background script that download is complete
  task.state = 'completed';
  broadcastProgress(task);

  chrome.runtime.sendMessage({
    action: 'SAVE_COMPLETED_TASK',
    filename: filename,
    taskId: task.id,
    taskUrl: task.url,
    taskTitle: task.title
  }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
}

// Clean filename helper
function getCleanFilename(title, defaultExt = '.mp4') {
  if (!title) return 'mediadown-video' + defaultExt;
  let clean = title.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (clean.length > 120) {
    clean = clean.substring(0, 120);
  }
  if (!clean.endsWith(defaultExt)) {
    clean += defaultExt;
  }
  return clean;
}

// URL resolving
function resolveUrl(baseUrl, relativeUrl) {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch (e) {
    return relativeUrl;
  }
}

// Broadcast task progress to background.js
function broadcastProgress(task) {
  const percent = task.totalSegments > 0 ? (task.downloadedCount / task.totalSegments) * 100 : 0;
  
  chrome.runtime.sendMessage({
    action: 'DOWNLOAD_PROGRESS',
    taskId: task.id,
    // Lets the background rebuild the task if its worker was restarted
    url: task.url,
    title: task.title,
    type: task.type,
    resolution: task.resolution,
    state: task.state,
    downloadedCount: task.downloadedCount,
    totalSegments: task.totalSegments,
    progress: percent,
    speed: task.speedTracker.currentSpeed,
    eta: task.etaText || '--:--',
    errorMsg: task.errorMsg || ''
  }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
}

// Cleanup resources
function cleanupTask(task) {
  task.downloadedBuffers = [];
  task.segmentUrls = [];
}

// Speed tracker interval
function startSpeedInterval(task) {
  task.speedTracker.lastTime = Date.now();
  task.speedTracker.bytes = 0;

  task.speedInterval = setInterval(() => {
    const now = Date.now();
    const duration = (now - task.speedTracker.lastTime) / 1000;
    if (duration > 0) {
      const bps = task.speedTracker.bytes / duration;
      task.speedTracker.currentSpeed = bps / (1024 * 1024); // convert to MB/s

      const remaining = task.totalSegments - task.downloadedCount;
      if (task.downloadedCount > 0 && remaining > 0) {
        const elapsedTime = (now - task.startTime) / 1000;
        const avgTimePerSegment = elapsedTime / task.downloadedCount;
        const etaSeconds = Math.round(remaining * avgTimePerSegment);
        const m = Math.floor(etaSeconds / 60);
        const s = etaSeconds % 60;
        task.etaText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
      } else {
        task.etaText = '--:--';
      }

      task.speedTracker.bytes = 0;
      task.speedTracker.lastTime = now;
      
      broadcastProgress(task);
    }
  }, 1000);
}

function stopSpeedInterval(task) {
  if (task.speedInterval) {
    clearInterval(task.speedInterval);
    task.speedInterval = null;
  }
}

// Close offscreen document if no active tasks are running
function checkAndCloseOffscreen() {
  const running = Object.values(activeTasks).some(t => t.state === 'downloading' || t.state === 'parsing' || t.state === 'paused');
  if (!running) {
    // Tell background script that we can close
    chrome.runtime.sendMessage({ action: 'OFFSCREEN_IDLE' }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }
}
