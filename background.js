importScripts('streams.js');

const detectedStreams = {}; // { [tabId]: { m3u8: { [url]: url }, ts: {...}, file: {...} } } oldest first
const streamInfo = {}; // { [m3u8 url]: parsePlaylist() result, [file url]: { kind: 'file', ext, size } }
const activeDownloads = {};
let creatingOffscreenPromise = null;

const MAX_URLS_PER_TYPE = 300;
// The service worker is stopped after ~30s idle and loses globals.
// Keep detected streams and download progress in storage.session and restore them on wake-up.
const ready = chrome.storage.session.get(['detectedStreams', 'streamInfo', 'activeDownloads']).then((saved) => {
  Object.assign(detectedStreams, saved.detectedStreams || {});
  Object.assign(streamInfo, saved.streamInfo || {});
  Object.assign(activeDownloads, saved.activeDownloads || {});
}).catch(() => {});

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.session.set({ detectedStreams, streamInfo, activeDownloads }).catch(() => {});
  }, 300);
}

// Remember a captured stream URL for the tab (newest last) and analyze new playlists
//   fileInfo: { ext, size } for direct video files
function recordStream(tabId, url, streamType, fileInfo) {
  if (isBlockedUrl(url)) return;
  if (!detectedStreams[tabId]) {
    detectedStreams[tabId] = { m3u8: {}, ts: {}, file: {} };
  }
  const bucket = detectedStreams[tabId][streamType] || (detectedStreams[tabId][streamType] = {});
  const isNew = !bucket[url];
  if (fileInfo) {
    const prev = streamInfo[url];
    streamInfo[url] = { kind: 'file', ext: fileInfo.ext, size: Math.max(fileInfo.size || 0, (prev && prev.size) || 0) };
  }

  // Re-insert so the latest request (fresh token) is last
  delete bucket[url];
  bucket[url] = url;
  const keys = Object.keys(bucket);
  if (keys.length > MAX_URLS_PER_TYPE) {
    keys.slice(0, keys.length - MAX_URLS_PER_TYPE).forEach(k => delete bucket[k]);
  }
  persist();

  if (!isNew) return;
  updateBadge(tabId);
  notifyStreamsUpdated(tabId);
  if (streamType === 'm3u8' && !streamInfo[url]) analyzePlaylist(tabId, url);
}

// Read the playlist once to know master/variant relations and content (used to collapse duplicates)
function analyzePlaylist(tabId, url) {
  fetchPlaylistText(url)
    .then(text => {
      const parsed = parsePlaylist(text, url);
      if (!parsed) return;
      streamInfo[url] = parsed;
      persist();
      updateBadge(tabId);
      notifyStreamsUpdated(tabId);
    })
    .catch(() => { /* CORS/auth failures: grouped by path only */ });
}

function fetchPlaylistText(url) {
  // Try without credentials first for public CDNs (wildcard CORS),
  // then with the user's own cookies for sites the user is signed in to.
  const get = (opts) => fetch(url, opts).then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
  return get().catch(() => get({ credentials: 'include' }));
}

function notifyStreamsUpdated(tabId) {
  chrome.runtime.sendMessage({ action: 'STREAMS_UPDATED', tabId }, () => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
}

// List shown in the popup: one entry per video (see collapseStreams), or every captured URL when raw
function streamsForTab(tabId, raw) {
  const streams = detectedStreams[tabId];
  if (!streams) return { m3u8: [], ts: [], file: [], meta: {} };
  const m3u8 = Object.values(streams.m3u8);
  const ts = Object.values(streams.ts);
  const file = Object.values(streams.file || {});
  if (raw) return { m3u8, ts, file, meta: {} };
  return collapseStreams(m3u8, ts, streamInfo, file);
}

// Request types a <video src="...mp4"> or an opened video tab uses. Adaptive players fetch
// fragments with XHR/fetch, so those only count when the response is a whole large file.
const FILE_REQUEST_TYPES = new Set(['media', 'main_frame', 'sub_frame', 'object', 'other']);
const MIN_XHR_FILE_SIZE = 20 * 1024 * 1024;

function detectVideoFile(details, contentType) {
  const ct = contentType.toLowerCase();
  const isVideoType = ct.startsWith('video/') && !ct.includes('mp2t');
  const isBinary = ct.includes('octet-stream') || ct === '';
  const ext = videoFileExt(details.url, ct);
  if (!ext || !(isVideoType || isBinary)) return null;
  if (/\.m4s$/i.test(pathKeyOf(details.url))) return null;

  const size = totalSizeOf(details.responseHeaders, details.statusCode);
  if (!FILE_REQUEST_TYPES.has(details.type) && size < MIN_XHR_FILE_SIZE) return null;
  return { ext, size };
}

// Listen for network requests to detect HLS playlist (.m3u8) or TS segment (.ts)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0) return;
    if (isBlockedUrl(details.initiator || '')) return; // requests made by YouTube pages

    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.toLowerCase();
      const search = urlObj.search.toLowerCase();

      let streamType = null;
      if (pathname.includes('.m3u8') || search.includes('.m3u8') || pathname.includes('/m3u8')) {
        streamType = 'm3u8';
      } else if (pathname.includes('.ts') || search.includes('.ts') || pathname.includes('/ts/') || pathname.includes('/segment-')) {
        streamType = 'ts';
      }

      if (streamType) {
        ready.then(() => recordStream(tabId, url, streamType));
      }
    } catch (e) {
      console.error("Error parsing URL in webRequest: ", e);
    }
  },
  { urls: ["<all_urls>"] }
);

// Listen to response headers to detect M3U8/TS streams without extensions in their URLs
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, tabId, responseHeaders } = details;
    if (tabId < 0) return;
    if (isBlockedUrl(details.initiator || '')) return; // requests made by YouTube pages

    try {
      const contentTypeHeader = responseHeaders.find(h => h.name.toLowerCase() === 'content-type');
      const contentType = contentTypeHeader ? contentTypeHeader.value.toLowerCase() : '';
      let streamType = null;
      if (contentType.includes('mpegurl') || contentType.includes('m3u8')) {
        streamType = 'm3u8';
      } else if (contentType.includes('video/mp2t')) {
        streamType = 'ts';
      }

      if (streamType) {
        ready.then(() => recordStream(tabId, url, streamType));
        return;
      }

      const file = detectVideoFile(details, contentType);
      if (file) {
        ready.then(() => recordStream(tabId, url, 'file', file));
      }
    } catch (e) {
      console.error("Error in onHeadersReceived sniffer: ", e);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

function updateBadge(tabId) {
  const streams = detectedStreams[tabId];
  if (!streams) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }
  const shown = streamsForTab(tabId, false);
  const total = shown.m3u8.length + shown.ts.length + shown.file.length;
  chrome.action.setBadgeText({
    text: total > 0 ? total.toString() : '',
    tabId
  });
  chrome.action.setBadgeBackgroundColor({
    color: '#8B5CF6',
    tabId
  });
}

// Clear streams when the tab reloads or closes
// chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
//   if (changeInfo.status === 'loading') {
//     delete detectedStreams[tabId];
//     updateBadge(tabId);
//   }
// });

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => {
    delete detectedStreams[tabId];
    pruneStreamInfo();
    persist();
  });
});

// Drop parsed playlists no tab refers to any more
function pruneStreamInfo() {
  const alive = new Set();
  Object.values(detectedStreams).forEach(s => {
    Object.keys(s.m3u8).forEach(u => alive.add(u));
    Object.keys(s.file || {}).forEach(u => alive.add(u));
  });
  Object.keys(streamInfo).forEach(u => {
    if (!alive.has(u)) delete streamInfo[u];
  });
}

// Create offscreen document helper
async function createOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['BLOBS'],
    justification: 'Download HLS / TS segments and merge them into one video Blob for saving'
  }).catch((err) => {
    console.error("Failed to create offscreen document:", err);
  });

  await creatingOffscreenPromise;
  creatingOffscreenPromise = null;
}

// Check if offscreen document exists
async function hasOffscreenDocument() {
  if (chrome.offscreen.hasDocument) {
    return await chrome.offscreen.hasDocument();
  }
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return contexts.length > 0;
  }
  return false;
}

// Actions answered here; other messages (popup/offscreen broadcasts) are not ours
const HANDLED_ACTIONS = new Set([
  'getStreams', 'clearStreams', 'deleteStream', 'addManualStream', 'getActiveDownloads', 'startDownload',
  'pauseDownload', 'cancelDownload', 'TRIGGER_DOWNLOAD_FROM_BG', 'SAVE_COMPLETED_TASK', 'DOWNLOAD_PROGRESS',
  'fetchHlsText', 'OFFSCREEN_IDLE'
]);

// Message receiver for routing between Popup, Background, and Offscreen Document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!HANDLED_ACTIONS.has(message.action)) return false;
  // Wait until state is restored (the worker may have just been woken up by this message)
  ready.then(() => handleMessage(message, sendResponse));
  return true;
});

function handleMessage(message, sendResponse) {
  const { action, tabId, taskId, url, title, type, resolution } = message;

  if (action === 'getStreams') {
    sendResponse(streamsForTab(tabId, message.raw));
  }

  else if (action === 'clearStreams') {
    delete detectedStreams[tabId];
    pruneStreamInfo();
    persist();
    updateBadge(tabId);
    sendResponse({ success: true });
  }

  else if (action === 'deleteStream') {
    // Remove every captured URL shown as this entry (token variants, master's variants)
    const streams = detectedStreams[tabId];
    if (streams && streams[type]) {
      const targets = message.raw ? [url] : relatedUrls(url, Object.keys(streams[type]), streamInfo);
      targets.forEach(u => delete streams[type][u]);
      pruneStreamInfo();
      persist();
      updateBadge(tabId);
    }
    sendResponse({ success: true });
  }

  else if (action === 'addManualStream') {
    if (isBlockedUrl(url)) {
      sendResponse({ success: false, error: 'blocked' });
      return;
    }
    if (type === 'file') {
      recordStream(tabId, url, 'file', { ext: videoFileExt(url) || 'mp4', size: 0 });
    } else {
      recordStream(tabId, url, type === 'ts' ? 'ts' : 'm3u8');
    }
    sendResponse({ success: true });
  }

  else if (action === 'getActiveDownloads') {
    // HLS/TS tasks live in the offscreen document; without it they can't be running (e.g. it crashed).
    // Video files are downloaded by Chrome itself, so they are refreshed from chrome.downloads.
    hasOffscreenDocument().then(async (alive) => {
      if (!alive) {
        Object.values(activeDownloads).forEach(t => {
          if (t.type !== 'file') delete activeDownloads[t.id];
        });
      }
      await refreshFileTasks();
      persist();
      sendResponse({ activeDownloads });
    });
  }

  else if (action === 'startDownload') {
    if (isBlockedUrl(url)) {
      sendResponse({ success: false, error: 'blocked' });
      return;
    }
    if (type === 'file') {
      const existing = activeDownloads[taskId];
      if (existing && existing.state === 'paused' && existing.downloadId != null) {
        chrome.downloads.resume(existing.downloadId, () => void chrome.runtime.lastError);
      } else {
        startFileDownload(taskId, url, title);
      }
      sendResponse({ success: true });
      return;
    }
    // The popup already sends the newest captured URL (fresh token) of the entry
    const targetUrl = url;

    activeDownloads[taskId] = {
      id: taskId,
      url: targetUrl,
      title,
      type,
      resolution,
      progress: 0,
      speed: 0,
      eta: '--:--',
      state: 'parsing',
      downloadedCount: 0,
      totalSegments: 0
    };
    persist();

    createOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        action: 'START_DOWNLOAD',
        taskId,
        url: targetUrl,
        title,
        type,
        resolution
      }, () => {
        if (chrome.runtime.lastError) { /* ignore channel close when offscreen is booting */ }
      });
    });
    sendResponse({ success: true });
  } 
  
  else if (action === 'pauseDownload') {
    const task = activeDownloads[taskId];
    if (task) {
      task.state = 'paused';
      persist();
    }
    if (task && task.type === 'file') {
      if (task.downloadId != null) chrome.downloads.pause(task.downloadId, () => void chrome.runtime.lastError);
    } else {
      chrome.runtime.sendMessage({ action: 'PAUSE_DOWNLOAD', taskId }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    }
    sendResponse({ success: true });
  }

  else if (action === 'cancelDownload') {
    const task = activeDownloads[taskId];
    delete activeDownloads[taskId];
    persist();
    if (task && task.type === 'file') {
      if (task.downloadId != null) chrome.downloads.cancel(task.downloadId, () => void chrome.runtime.lastError);
    } else {
      chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD', taskId }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    }
    sendResponse({ success: true });
  }
  
  else if (action === 'TRIGGER_DOWNLOAD_FROM_BG') {
    chrome.downloads.download({
      url: message.blobUrl,
      filename: message.filename,
      saveAs: false
    }, (downloadId) => {
      const task = activeDownloads[message.taskId];
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message;
        if (task) {
          task.state = 'error';
          task.errorMsg = `저장 에러: ${errorMsg}`;
          broadcastProgressToPopup(task);
        }
        chrome.runtime.sendMessage({ action: 'DOWNLOAD_FAILED_CLEANUP', taskId: message.taskId, errorMsg }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      } else {
        if (task) {
          task.downloadId = downloadId;
          task.state = 'completed';
          broadcastProgressToPopup(task);
          saveCompletedTaskToStorage(task, message.filename);
          delete activeDownloads[message.taskId];
          persist();
        }
        chrome.runtime.sendMessage({ action: 'DOWNLOAD_SUCCESS_CLEANUP', taskId: message.taskId, downloadId }, () => {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      }
    });
    sendResponse({ success: true });
  }
  
  else if (action === 'SAVE_COMPLETED_TASK') {
    const task = activeDownloads[message.taskId] || message.task || { id: message.taskId, url: message.taskUrl, title: message.taskTitle };
    if (task) {
      task.state = 'completed';
      delete activeDownloads[message.taskId];
      persist();
      // The merged file is saved by the offscreen page itself: look up its download id by the blob URL
      findDownloadIdByUrl(message.blobUrl).then((downloadId) => {
        if (downloadId != null) task.downloadId = downloadId;
        saveCompletedTaskToStorage(task, message.filename);
      });
    }
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_SUCCESS_CLEANUP', taskId: message.taskId }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
    sendResponse({ success: true });
  }

  else if (action === 'DOWNLOAD_PROGRESS') {
    // Rebuild the entry if it was lost (offscreen keeps downloading even if this worker restarted)
    if (!activeDownloads[taskId] && message.url && message.state !== 'completed') {
      activeDownloads[taskId] = { id: taskId, url: message.url, title: message.title, type: message.type, resolution: message.resolution };
    }
    const task = activeDownloads[taskId];
    if (task) {
      task.state = message.state;
      task.downloadedCount = message.downloadedCount;
      task.totalSegments = message.totalSegments;
      task.progress = message.progress;
      task.speed = message.speed;
      task.eta = message.eta;
      task.errorMsg = message.errorMsg;

      if (message.state === 'completed') {
        delete activeDownloads[taskId];
      }
      persist();

      chrome.runtime.sendMessage({
        action: 'DOWNLOAD_PROGRESS_UPDATE',
        task: activeDownloads[taskId] || { id: taskId, state: message.state, errorMsg: message.errorMsg }
      }, () => {
        if (chrome.runtime.lastError) { /* ignore closed popup errors */ }
      });
    }
    sendResponse({ success: true });
  } 
  
  else if (action === 'fetchHlsText') {
    fetchPlaylistText(url)
      .then(text => sendResponse({ success: true, text }))
      .catch(e => sendResponse({ success: false, error: e.message }));
  }

  else if (action === 'OFFSCREEN_IDLE') {
    chrome.offscreen.closeDocument().catch(() => {});
    sendResponse({ success: true });
  }
}

// ---- Direct video files: downloaded by Chrome (no merging, no memory use), progress read back from chrome.downloads ----

function startFileDownload(taskId, url, title) {
  const info = streamInfo[url] || {};
  const ext = '.' + (info.ext || videoFileExt(url) || 'mp4');
  activeDownloads[taskId] = {
    id: taskId,
    url,
    title,
    type: 'file',
    resolution: 'best',
    progress: 0,
    speed: 0,
    eta: '--:--',
    state: 'downloading',
    downloadedCount: 0,
    totalSegments: 0,
    bytesReceived: 0,
    totalBytes: info.size || 0
  };
  persist();

  chrome.downloads.download({ url, filename: getCleanFilename(title, ext), saveAs: false }, (downloadId) => {
    const task = activeDownloads[taskId];
    if (!task) return;
    if (chrome.runtime.lastError || downloadId === undefined) {
      task.state = 'error';
      task.errorMsg = `다운로드 시작 실패: ${chrome.runtime.lastError ? chrome.runtime.lastError.message : ''}`;
      delete activeDownloads[taskId];
      persist();
      broadcastProgressToPopup(task);
      return;
    }
    task.downloadId = downloadId;
    persist();
  });
}

// Copy Chrome's download progress into the file tasks (called when the popup asks)
async function refreshFileTasks() {
  const tasks = Object.values(activeDownloads).filter(t => t.type === 'file' && t.downloadId != null);
  for (const task of tasks) {
    const [item] = await chrome.downloads.search({ id: task.downloadId });
    if (!item) {
      delete activeDownloads[task.id];
      continue;
    }
    const now = Date.now();
    if (task.lastTime && now > task.lastTime) {
      task.speed = Math.max(0, (item.bytesReceived - task.bytesReceived) / ((now - task.lastTime) / 1000)) / (1024 * 1024);
    }
    task.lastTime = now;
    task.bytesReceived = item.bytesReceived;
    task.totalBytes = item.totalBytes > 0 ? item.totalBytes : task.totalBytes;
    task.progress = task.totalBytes > 0 ? (item.bytesReceived / task.totalBytes) * 100 : 0;
    if (item.paused) task.state = 'paused';
    else if (item.state === 'in_progress') task.state = 'downloading';
    task.eta = '--:--';
    if (item.estimatedEndTime && !item.paused) {
      const sec = Math.max(0, Math.round((new Date(item.estimatedEndTime).getTime() - now) / 1000));
      task.eta = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    }
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  ready.then(() => {
    const task = Object.values(activeDownloads).find(t => t.type === 'file' && t.downloadId === delta.id);
    if (!task) return;

    if (delta.state && delta.state.current === 'complete') {
      delete activeDownloads[task.id];
      persist();
      chrome.downloads.search({ id: delta.id }, ([item]) => {
        const filename = item && item.filename ? item.filename.split(/[\\/]/).pop() : task.title;
        saveCompletedTaskToStorage(task, filename);
        // Tell the popup after the history is saved so its list includes this file
        setTimeout(() => broadcastProgressToPopup({ ...task, state: 'completed', progress: 100 }), 100);
      });
    } else if (delta.state && delta.state.current === 'interrupted') {
      delete activeDownloads[task.id];
      persist();
      if (delta.error && delta.error.current === 'USER_CANCELED') {
        chrome.runtime.sendMessage({ action: 'DOWNLOAD_CANCELLED', taskId: task.id }, () => void chrome.runtime.lastError);
      } else {
        broadcastProgressToPopup({ ...task, state: 'error', errorMsg: `다운로드 실패: ${delta.error ? delta.error.current : ''}` });
      }
    } else if (delta.paused) {
      task.state = delta.paused.current ? 'paused' : 'downloading';
      persist();
      broadcastProgressToPopup(task);
    }
  });
});

// Same rule as the offscreen merger
function getCleanFilename(title, defaultExt = '.mp4') {
  if (!title) return 'mediadown-video' + defaultExt;
  // chrome.downloads also rejects control characters and names ending with a dot/space
  let clean = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (clean.length > 120) {
    clean = clean.substring(0, 120);
  }
  clean = clean.replace(/[. ]+$/, '') || 'mediadown-video';
  if (!clean.endsWith(defaultExt)) {
    clean += defaultExt;
  }
  return clean;
}

// The download item appears shortly after the save starts: retry for a few seconds
async function findDownloadIdByUrl(url) {
  if (!url) return null;
  for (let i = 0; i < 10; i++) {
    const [item] = await chrome.downloads.search({ url, orderBy: ['-startTime'], limit: 1 });
    if (item) return item.id;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

function broadcastProgressToPopup(task) {
  chrome.runtime.sendMessage({
    action: 'DOWNLOAD_PROGRESS_UPDATE',
    task
  }, () => {
    if (chrome.runtime.lastError) { /* ignore closed popup errors */ }
  });
}

function saveCompletedTaskToStorage(task, finalFilename) {
  let hostname = '';
  try {
    hostname = new URL(task.url).hostname;
  } catch(e) {}

  const completedItem = {
    id: task.id,
    downloadId: task.downloadId,
    title: task.title,
    filename: finalFilename,
    domain: hostname || '웹 비디오',
    time: Date.now()
  };

  chrome.storage.local.get({ completedDownloads: [] }, (res) => {
    let list = res.completedDownloads || [];
    list.unshift(completedItem);
    if (list.length > 10) {
      list = list.slice(0, 10);
    }
    chrome.storage.local.set({ completedDownloads: list });
  });
}
