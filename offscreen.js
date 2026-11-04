// Offscreen Downloader Engine
const activeTasks = {};

// Error texts in the browser language: offscreen documents can only use chrome.runtime, so background sends them
let messages = {};
const t = key => messages[key] || key;

// Handle incoming messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, taskId, url, title, type, resolution, downloadId, errorMsg } = message;

  if (action === 'START_DOWNLOAD') {
    if (message.messages) messages = message.messages;
    startTask(taskId, url, title, type, resolution, message.pageHeaders);
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
async function startTask(taskId, url, title, type, resolution, pageHeaders) {
  let task = activeTasks[taskId];

  if (!task) {
    task = {
      id: taskId,
      url: url,
      title: title,
      type: type,
      resolution: resolution,
      pageHeaders: pageHeaders || null, // { referer, origin } of the page the video was played on
      headerHosts: new Set(),
      headerRulePromise: null,
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
      const video = await fetchAndParseM3u8Recursively(task, targetUrl);
      // Audio the stream keeps in its own playlist (#EXT-X-MEDIA): downloaded after the video, muxed in on save
      const audio = task.audioPlaylistUrl && video.length ? await fetchAndParseM3u8Recursively(task, task.audioPlaylistUrl) : [];
      task.isFmp4 = video.some(seg => seg.init);
      task.audioIsFmp4 = audio.some(seg => seg.init);
      task.videoSegmentCount = video.length;
      task.segmentUrls = video.concat(audio);
      task.totalSegments = task.segmentUrls.length;
      if (task.totalSegments === 0) {
        throw new Error(t('errNoSegments'));
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
            if (await urlExists(task, probeUrl0)) {
              task.seqStartVal = 0;
            } else {
              const probeUrl1 = getSequenceUrl(task, 1 - task.seqStartVal);
              if (await urlExists(task, probeUrl1)) {
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

async function urlExists(task, url) {
  try {
    const res = await taskFetch(task, url, { method: 'HEAD' });
    return res.ok;
  } catch(e) {
    try {
      const res = await taskFetch(task, url);
      return res.ok;
    } catch(err) {
      return false;
    }
  }
}

// Some sites serve the video only with the user's cookies (the detection in background.js already
// retries this way). Retry once with credentials and keep using them for the rest of the task.
async function taskFetch(task, url, opts = {}) {
  await usePageHeaders(task, url);
  if (task.useCredentials) return fetch(url, { ...opts, credentials: 'include' });
  try {
    const res = await fetch(url, opts);
    if (res.status !== 401 && res.status !== 403) return res;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  const retry = await fetch(url, { ...opts, credentials: 'include' });
  if (retry.ok) task.useCredentials = true;
  return retry;
}

// Some sites only serve requests coming from their own page: ask the background to send the page's
// Referer/Origin with this task's requests. The rule lists the hosts seen so far, so it is updated per new host.
function usePageHeaders(task, url) {
  if (!task.pageHeaders) return Promise.resolve();
  let host;
  try { host = new URL(url).hostname; } catch (e) { return Promise.resolve(); }
  if (task.headerHosts.has(host)) return task.headerRulePromise;
  task.headerHosts.add(host);
  task.headerRulePromise = new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: 'setPageHeaders',
      taskId: task.id,
      hosts: [...task.headerHosts],
      pageHeaders: task.pageHeaders
    }, () => {
      if (chrome.runtime.lastError) { /* download without page headers */ }
      resolve();
    });
  });
  return task.headerRulePromise;
}

// Error with the likely reason for 401/403 and the start of the server's message
async function httpError(what, url, response) {
  let msg = `${what ? what + ' ' : ''}(HTTP ${response.status})`;
  let body = '';
  try { body = await response.text(); } catch (e) {}
  // Cloudflare's own block/challenge page (a 403 passed through from the origin server has its own body)
  const cloudflare = /cloudflare|attention required|just a moment/i.test(body);

  if (response.status === 401 || response.status === 403) {
    const tokenLike = /[?&](expires?|exp|e|token|tk|sig|signature|hdnts|hdntl|policy|key-pair-id|st|auth|hash|md5)=/i.test(url);
    if (cloudflare) {
      msg += ' — ' + t('errCloudflare');
    } else if (tokenLike) {
      msg += ' — ' + t('errTokenExpired');
    } else {
      msg += ' — ' + t('errRejected');
    }
  }
  const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (text) msg += ` [${t('serverResponse')}: ${text}]`;
  return new Error(msg);
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
    throw new Error(t('errTooDeep'));
  }

  const response = await taskFetch(task, url);
  if (!response.ok) {
    throw await httpError(t('playlistLoadFailed'), url, response);
  }
  
  const text = await response.text();
  if (!text.trim().startsWith('#EXTM3U')) {
    throw new Error(t('errNotM3u8'));
  }
  const lines = text.split('\n');
  const segmentUrls = [];
  const masterPlaylists = [];
  const audioRenditions = [];
  const baseUrl = url;
  
  let currentKey = null;
  let currentIv = null;
  let mediaSequence = 0;
  // #EXT-X-BYTERANGE: segments are parts of one file. Without an offset a part follows the previous one of that file.
  let pendingRange = null;
  const rangeEnd = {};
  const rangeOf = (spec, segUrl) => {
    const [length, offset] = spec.split('@').map(Number);
    const start = isNaN(offset) ? (rangeEnd[segUrl] || 0) : offset;
    rangeEnd[segUrl] = start + length;
    return [start, start + length - 1];
  };

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
        throw new Error(t('errDrm'));
      }
      if (line.startsWith('#EXT-X-SESSION-KEY:')) continue;
      if (method === 'AES-128') {
        const uriMatch = line.match(/URI="([^"]+)"/);
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);
        if (uriMatch) {
          const keyUrl = resolveUrl(baseUrl, uriMatch[1]);
          // Without the key every segment would fail to decrypt: stop here with the real reason
          const keyRes = await taskFetch(task, keyUrl);
          if (!keyRes.ok) {
            throw await httpError(t('keyLoadFailed'), keyUrl, keyRes);
          }
          const keyBuffer = await keyRes.arrayBuffer();
          currentKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
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
    } else if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      audioRenditions.push({
        group: (line.match(/GROUP-ID="([^"]+)"/) || [])[1] || '',
        url: uriMatch ? resolveUrl(baseUrl, uriMatch[1]) : null, // no URI: the audio is inside the variant
        isDefault: /DEFAULT=YES/.test(line)
      });
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
          resolution: res,
          codecs: (line.match(/CODECS="([^"]+)"/) || [])[1] || '',
          audioGroup: (line.match(/AUDIO="([^"]+)"/) || [])[1] || ''
        });
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const match = line.match(/URI="([^"]+)"/);
      if (match) {
        const segUrl = resolveUrl(baseUrl, match[1]);
        const byteRange = line.match(/BYTERANGE="([^"]+)"/);
        const range = byteRange ? rangeOf(byteRange[1], segUrl) : null;
        segmentUrls.push({ url: segUrl, key: currentKey, iv: currentIv, seq: mediaSequence, init: true, range });
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.substring('#EXT-X-BYTERANGE:'.length);
    } else if (!line.startsWith('#')) {
      let iv = currentIv;
      if (currentKey && !iv) {
        iv = new Uint8Array(16);
        const view = new DataView(iv.buffer);
        view.setUint32(12, mediaSequence, false);
      }
      const segUrl = resolveUrl(baseUrl, line);
      const range = pendingRange ? rangeOf(pendingRange, segUrl) : null;
      pendingRange = null;
      segmentUrls.push({ url: segUrl, key: currentKey, iv: iv, seq: mediaSequence, range });
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
    // The same video is often listed once per audio group: prefer AAC (AC-3 / E-AC-3 does not play everywhere)
    const isDolby = (p) => /\b(ac-3|ec-3)\b/i.test(p.codecs);
    if (isDolby(selectedPlaylist)) {
      selectedPlaylist = masterPlaylists.find(p => p.url === selectedPlaylist.url && !isDolby(p)) || selectedPlaylist;
    }
    // The variant's audio group: its default rendition, else the first. One without URI means the variant has the audio.
    const group = audioRenditions.filter(r => r.group === selectedPlaylist.audioGroup);
    const audio = group.find(r => r.isDefault) || group[0];
    task.audioPlaylistUrl = audio && audio.url ? audio.url : null;
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
        task.errorMsg = `${t('mergeFailed')}: ${err.message}`;
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
        task.errorMsg = `${t('mergeFailed')}: ${err.message}`;
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
        const segRange = typeof seg === 'string' ? null : seg.range;
        const buffer = await fetchSegment(task, segUrl, task.abortController.signal, segKey, segIv, segRange);
        task.downloadedBuffers[nextIdx] = buffer;
        success = true;
        task.downloadedCount++;
        broadcastProgress(task);
      } catch (err) {
        if (err.name === 'AbortError') break;
        retries--;
        if (retries === 0) {
          task.state = 'error';
          task.errorMsg = `${t('segmentFailed')} (${nextIdx + 1}/${task.totalSegments}): ${err.message}`;
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
        const response = await taskFetch(task, url, { signal: task.abortController.signal });
        if (response.status === 404) {
          is404 = true;
          break;
        }
        if (!response.ok) {
          throw await httpError('', url, response);
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
async function fetchSegment(task, url, signal, key = null, iv = null, range = null) {
  const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : undefined;
  const response = await taskFetch(task, url, { signal, headers });
  if (!response.ok) {
    throw await httpError('', url, response);
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

  let combined = new Uint8Array(receivedLength);
  let position = 0;
  for (let chunk of chunks) {
    combined.set(chunk, position);
    position += chunk.length;
  }
  // Server ignored the Range header and sent the whole file
  if (range && response.status === 200 && receivedLength > range[1]) {
    combined = combined.slice(range[0], range[1] + 1);
  }

  if (key && iv) {
    try {
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, combined.buffer);
      return decrypted;
    } catch (e) {
      console.error("AES Decryption failed for segment:", e);
      throw new Error(t('errDecrypt'));
    }
  }
  
  return combined.buffer;
}

// Merge buffers and download
// Merge buffers and download
function mergeAndSaveTask(task) {
  const videoCount = task.videoSegmentCount || task.downloadedBuffers.length;
  const validChunks = task.downloadedBuffers.slice(0, videoCount).filter(buf => buf !== null);
  const audioChunks = task.downloadedBuffers.slice(videoCount).filter(buf => buf !== null);

  let finalBlob = audioChunks.length ? withSeparateAudio(task, validChunks, audioChunks) : null;
  let defaultExt = '.mp4';

  if (finalBlob) {
    // video and its separate audio in one MP4; when that failed, the video alone is saved below
  } else if (!task.isFmp4 && typeof muxjs !== 'undefined') {
    // Use mux.js to properly remux TS into a valid MP4 container so it opens in all players
    try {
      const { mp4, initSegment, firstPts, lastPts } = transmux(validChunks);

      if (mp4.fragments.length > 0) {
        try {
          finalBlob = mp4.toBlob();
        } catch (err) {
          // Could not rebuild: save the fragmented MP4 as mux.js made it (plays, seeks slower)
          console.warn('Regular MP4 rebuild failed, saving fragmented MP4:', err);
          const init = initSegment && lastPts > firstPts ? withDuration(initSegment, lastPts - firstPts) : initSegment;
          finalBlob = new Blob(init ? [init, ...mp4.fragments] : mp4.fragments, { type: 'video/mp4' });
        }
      } else {
        finalBlob = new Blob(validChunks, { type: 'video/mp2t' });
        defaultExt = '.ts';
      }
    } catch (err) {
      console.warn('Mux.js remuxing failed, saving the original TS:', err);
      finalBlob = new Blob(validChunks, { type: 'video/mp2t' });
      defaultExt = '.ts';
    }
  } else if (task.isFmp4) {
    try {
      finalBlob = fmp4Of(validChunks).toBlob();
    } catch (err) {
      console.warn('Regular MP4 rebuild failed, saving fragmented MP4:', err);
      finalBlob = new Blob(validChunks, { type: 'video/mp4' });
    }
  } else {
    finalBlob = new Blob(validChunks, { type: 'video/mp2t' });
    defaultExt = '.ts';
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
    blobUrl: blobUrl, // lets the background find Chrome's download id (folder / play buttons)
    taskId: task.id,
    taskUrl: task.url,
    taskTitle: task.title
  }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
}

// One regular MP4 with the video's tracks and the audio track of the separate audio playlist (null if that failed)
function withSeparateAudio(task, videoChunks, audioChunks) {
  try {
    const video = task.isFmp4 ? fmp4Of(videoChunks) : transmux(videoChunks).mp4;
    if (video.hasTrack('soun')) return video.toBlob(); // the variant has its own sound after all
    const audio = task.audioIsFmp4 ? fmp4Of(audioChunks) : transmux(audioChunks).mp4;
    return FaststartMp4.combine([video, audio]);
  } catch (err) {
    console.warn('Adding the separate audio failed, saving the video only:', err);
    return null;
  }
}

// fMP4 HLS: the segments already are fragments of one MP4 (EXT-X-MAP init + moof/mdat)
function fmp4Of(chunks) {
  const mp4 = new FaststartMp4();
  chunks.forEach(chunk => mp4.addSegment(chunk));
  return mp4;
}

// TS (or raw AAC) segments -> mux.js fragments, collected for a regular MP4.
// Fragments are kept as Blobs: Chrome can keep large Blobs on disk, and no single buffer
// the size of the whole video is ever allocated.
function transmux(chunks) {
  const transmuxer = new muxjs.mp4.Transmuxer();
  const mp4 = new FaststartMp4();
  let initSegment = null;

  transmuxer.on('data', (segment) => {
    if (segment.initSegment && !initSegment) {
      initSegment = segment.initSegment;
      mp4.setInit(initSegment);
    }
    if (segment.data) {
      mp4.addFragment(segment.data);
    }
  });
  // Time span of the whole output (90kHz clock) for the file's duration
  let firstPts = Infinity;
  let lastPts = 0;
  const onTiming = (info) => {
    firstPts = Math.min(firstPts, info.start.pts);
    lastPts = Math.max(lastPts, info.end.pts);
  };
  transmuxer.on('videoSegmentTimingInfo', onTiming);
  transmuxer.on('audioSegmentTimingInfo', onTiming);

  // Push and flush segment-by-segment so mux.js never holds the whole stream
  for (let chunk of chunks) {
    transmuxer.push(new Uint8Array(chunk));
    transmuxer.flush();
  }
  return { mp4, initSegment, firstPts, lastPts };
}

// mux.js writes "unknown" (0xFFFFFFFF) durations into the init segment, so players guess the length
// from the first fragment only. Write the real length into mvhd / tkhd / mdhd of a copy.
function withDuration(initSegment, duration90k) {
  const out = new Uint8Array(initSegment);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let movieScale = 90000;
  const write = (offset, version, value) => {
    if (version === 1) view.setBigUint64(offset, BigInt(value));
    else if (value < 0xFFFFFFFF) view.setUint32(offset, value);
  };
  const inScale = (scale) => Math.round(duration90k * scale / 90000);

  const walk = (start, end) => {
    let o = start;
    while (o + 8 <= end) {
      const size = view.getUint32(o);
      const type = String.fromCharCode(out[o + 4], out[o + 5], out[o + 6], out[o + 7]);
      if (size < 8 || o + size > end) return;
      const v = out[o + 8];
      if (type === 'moov' || type === 'trak' || type === 'mdia') {
        walk(o + 8, o + size);
      } else if (type === 'mvhd') {
        movieScale = view.getUint32(o + (v === 1 ? 28 : 20));
        write(o + (v === 1 ? 32 : 24), v, inScale(movieScale));
      } else if (type === 'tkhd') {
        write(o + (v === 1 ? 36 : 28), v, inScale(movieScale));
      } else if (type === 'mdhd') {
        const scale = view.getUint32(o + (v === 1 ? 28 : 20));
        write(o + (v === 1 ? 32 : 24), v, inScale(scale));
      }
      o += size;
    }
  };
  walk(0, out.byteLength);
  return out;
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
