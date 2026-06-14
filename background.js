const detectedStreams = {};
const activeDownloads = {};
let creatingOffscreenPromise = null;

function getUrlBasePath(url) {
  try {
    const urlObj = new URL(url);
    const lastSlash = urlObj.pathname.lastIndexOf('/');
    if (lastSlash !== -1) {
      return urlObj.host + urlObj.pathname.substring(0, lastSlash + 1);
    }
    return urlObj.host + urlObj.pathname;
  } catch (e) {
    return url;
  }
}

// Strip out dynamic timestamp or cache-buster parameters for strict deduplication
function cleanUrlForDeduplication(url) {
  try {
    const urlObj = new URL(url);
    const searchParams = new URLSearchParams(urlObj.search);
    
    // Remove dynamic timestamp/nonce query params
    const paramsToRemove = ['_', 't', 'time', 'timestamp', 'cb', 'cachebuster', 'seq', 'segment', 'nonce', 'r', 'random', 'start', 'end'];
    for (const param of paramsToRemove) {
      searchParams.delete(param);
    }
    
    // Remove purely numeric keys or values (timestamps/sequences)
    const keys = Array.from(searchParams.keys());
    for (const key of keys) {
      if (/^\d+$/.test(key) || /^\d+$/.test(searchParams.get(key))) {
        searchParams.delete(key);
      }
    }
    
    urlObj.search = searchParams.toString();
    return urlObj.toString();
  } catch (e) {
    return url;
  }
}

// Listen for network requests to detect HLS playlist (.m3u8) or TS segment (.ts)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0) return;

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
        if (!detectedStreams[tabId]) {
          detectedStreams[tabId] = { m3u8: {}, ts: {} };
        }
        
        const cleanedUrl = url;
        const isNew = !detectedStreams[tabId][streamType][cleanedUrl];
        
        // Always store/overwrite the URL to keep dynamic token fresh!
        detectedStreams[tabId][streamType][cleanedUrl] = url;
        
        if (isNew) {
          updateBadge(tabId);
          // Broadcast detected stream list update to popup if open
          chrome.runtime.sendMessage({ action: 'STREAMS_UPDATED', tabId }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        }
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

    try {
      const contentTypeHeader = responseHeaders.find(h => h.name.toLowerCase() === 'content-type');
      if (!contentTypeHeader) return;
      
      const contentType = contentTypeHeader.value.toLowerCase();
      let streamType = null;
      if (contentType.includes('mpegurl') || contentType.includes('m3u8')) {
        streamType = 'm3u8';
      } else if (contentType.includes('video/mp2t')) {
        streamType = 'ts';
      }

      if (streamType) {
        if (!detectedStreams[tabId]) {
          detectedStreams[tabId] = { m3u8: {}, ts: {} };
        }

        const cleanedUrl = url;
        const isNew = !detectedStreams[tabId][streamType][cleanedUrl];
        
        // Always store/overwrite the URL to keep dynamic token fresh!
        detectedStreams[tabId][streamType][cleanedUrl] = url;
        
        if (isNew) {
          updateBadge(tabId);
          // Broadcast detected stream list update to popup if open
          chrome.runtime.sendMessage({ action: 'STREAMS_UPDATED', tabId }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        }
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
  const total = Object.keys(streams.m3u8).length + Object.keys(streams.ts).length;
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
  delete detectedStreams[tabId];
});

// Create offscreen document helper
async function createOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['DOM_SCRAPING'],
    justification: 'Background HLS / TS downloading and video segment merging process'
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

// Message receiver for routing between Popup, Background, and Offscreen Document
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, tabId, taskId, url, title, type, resolution } = message;

  if (action === 'getStreams') {
    const streams = detectedStreams[tabId];
    if (streams) {
      sendResponse({
        m3u8: Object.values(streams.m3u8),
        ts: Object.values(streams.ts)
      });
    } else {
      sendResponse({ m3u8: [], ts: [] });
    }
  } 
  
  else if (action === 'clearStreams') {
    delete detectedStreams[tabId];
    updateBadge(tabId);
    sendResponse({ success: true });
  } 

  else if (action === 'deleteStream') {
    const streams = detectedStreams[tabId];
    if (streams) {
      try {
        const cleaned = cleanUrlForDeduplication(url);
        if (type === 'm3u8') delete streams.m3u8[cleaned];
        else if (type === 'ts') delete streams.ts[cleaned];
        updateBadge(tabId);
      } catch(e) {}
    }
    sendResponse({ success: true });
  }

  else if (action === 'addManualStream') {
    if (!detectedStreams[tabId]) {
      detectedStreams[tabId] = { m3u8: {}, ts: {} };
    }
    try {
      const cleaned = cleanUrlForDeduplication(url);
      if (type === 'm3u8') detectedStreams[tabId].m3u8[cleaned] = url;
      else if (type === 'ts') detectedStreams[tabId].ts[cleaned] = url;
      updateBadge(tabId);
    } catch(e) {}
    sendResponse({ success: true });
  }
  
  else if (action === 'getActiveDownloads') {
    sendResponse({ activeDownloads });
  } 
  
  else if (action === 'startDownload') {
    // Find the latest intercepted URL with a fresh token matching the base/cleaned URL
    let targetUrl = url;
    try {
      const cleaned = cleanUrlForDeduplication(url);
      for (const tId in detectedStreams) {
        const tabStreams = detectedStreams[tId];
        if (type === 'm3u8' && tabStreams.m3u8 && tabStreams.m3u8[cleaned]) {
          targetUrl = tabStreams.m3u8[cleaned];
          break;
        } else if (type === 'ts' && tabStreams.ts && tabStreams.ts[cleaned]) {
          targetUrl = tabStreams.ts[cleaned];
          break;
        }
      }
    } catch (e) {}

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
    if (activeDownloads[taskId]) {
      activeDownloads[taskId].state = 'paused';
    }
    chrome.runtime.sendMessage({ action: 'PAUSE_DOWNLOAD', taskId }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
    sendResponse({ success: true });
  } 
  
  else if (action === 'cancelDownload') {
    delete activeDownloads[taskId];
    chrome.runtime.sendMessage({ action: 'CANCEL_DOWNLOAD', taskId }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
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
      saveCompletedTaskToStorage(task, message.filename);
      delete activeDownloads[message.taskId];
    }
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_SUCCESS_CLEANUP', taskId: message.taskId }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
    sendResponse({ success: true });
  }

  else if (action === 'DOWNLOAD_PROGRESS') {
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
    // Try without credentials first for public CDNs (wildcard CORS).
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(text => sendResponse({ success: true, text }))
      .catch(err => {
        // Fallback to with credentials for private/authenticated streams
        fetch(url, { credentials: 'include' })
          .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
          })
          .then(text => sendResponse({ success: true, text }))
          .catch(e => sendResponse({ success: false, error: e.message }));
      });
    return true; // Keep message channel open for async response
  }
  
  else if (action === 'OFFSCREEN_IDLE') {
    chrome.offscreen.closeDocument().catch(() => {});
    sendResponse({ success: true });
  }
});

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
