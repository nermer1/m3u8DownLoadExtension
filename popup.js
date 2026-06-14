document.addEventListener('DOMContentLoaded', async () => {
  const streamsList = document.getElementById('streams-list');
  const totalCount = document.getElementById('total-count');
  const btnClear = document.getElementById('btn-clear');
  const manualUrlInput = document.getElementById('manual-url');
  const btnManualDownload = document.getElementById('btn-manual-download');
  
  const completedSection = document.getElementById('completed-section');
  const completedList = document.getElementById('completed-list');
  const btnHideHistory = document.getElementById('btn-hide-history');
  const btnClearHistory = document.getElementById('btn-clear-history');

  let activeTabId = null;
  let activeTabTitle = '';
  let streamMetadata = {}; // Cache for parsed HLS duration & resolutions
  let activeDownloads = {}; // Cached download progress from background
  let currentGroups = []; // Cache for current grouped streams
  let lastActiveStateStr = ''; // Cached serialized active download states

  // 1. Get the current active tab info
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab) {
    activeTabId = activeTab.id;
    activeTabTitle = activeTab.title;
    
    // Load lists
    await getActiveDownloads();
    await loadStreams();
    await loadCompletedHistory();
  }

  // Monitor updates of stream list from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'STREAMS_UPDATED' && message.tabId === activeTabId) {
      loadStreams();
    } else if (message.action === 'DOWNLOAD_PROGRESS_UPDATE') {
      updateProgressUI(message.task);
    } else if (message.action === 'DOWNLOAD_CANCELLED') {
      delete activeDownloads[message.taskId];
      loadStreams(); // Redraw cards to clean up download UI
    }
  });

  // Query active downloads from background
  async function getActiveDownloads() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getActiveDownloads' }, (response) => {
        activeDownloads = response?.activeDownloads || {};
        resolve();
      });
    });
  }

  // Load and render detected streams
  async function loadStreams() {
    if (!activeTabId) return;

    chrome.runtime.sendMessage({ action: 'getStreams', tabId: activeTabId }, async (response) => {
      if (chrome.runtime.lastError) {
        console.error("Error communicating with background:", chrome.runtime.lastError);
        return;
      }
      
      const { m3u8 = [], ts = [] } = response || {};
      
      // Group streams
      const newGroups = groupStreams(m3u8, ts);
      
      // Calculate fingerprints to detect visual/structural changes
      const currentKeys = currentGroups.map(g => g.groupKey).sort().join(',');
      const newKeys = newGroups.map(g => g.groupKey).sort().join(',');
      
      const currentSubUrlsCount = currentGroups.reduce((acc, g) => acc + Object.keys(g.urls).length, 0);
      const newSubUrlsCount = newGroups.reduce((acc, g) => acc + Object.keys(g.urls).length, 0);
      
      const activeStateStr = Object.values(activeDownloads).map(t => `${t.id}:${t.state}`).sort().join(',');
      
      const hasChanged = (currentKeys !== newKeys) || 
                         (currentSubUrlsCount !== newSubUrlsCount) || 
                         (currentGroups.length !== newGroups.length) ||
                         (activeStateStr !== lastActiveStateStr);
      
      if (!hasChanged) {
        // Silently update cache to keep URL objects (with fresh dynamic tokens) fresh in memory
        currentGroups = newGroups;
        return;
      }
      
      currentGroups = newGroups;
      lastActiveStateStr = activeStateStr;
      
      // Update badge count based on grouped items
      totalCount.textContent = currentGroups.length;

      if (currentGroups.length === 0) {
        renderEmptyState();
        return;
      }

      // Render the cards immediately
      renderStreamsList();


      // Pre-fetch metadata (duration & resolutions) ONLY for each group's mainUrl asynchronously
      currentGroups.forEach(group => {
        if (group.type === 'm3u8') {
          const url = group.mainUrl;
          const key = group.groupKey;
          if (!streamMetadata[key]) {
            fetchHlsMetadata(key, url).then(() => {
              const cardId = btoa(unescape(encodeURIComponent(group.groupKey))).replace(/=/g, '').substring(0, 32);
              const selectEl = document.querySelector(`[data-url="${cardId}"] .card-resolution-select`);
              const durationEl = document.querySelector(`[data-url="${cardId}"] .card-thumb-badge`);
              
              if (streamMetadata[key]) {
                const meta = streamMetadata[key];
                
                // Bind resolutions
                if (selectEl) {
                  const freshGroup = currentGroups.find(g => g.groupKey === group.groupKey) || group;
                  let resolutions = ['best'];
                  if (Object.keys(freshGroup.urls).length > 0) {
                    const detected = Object.keys(freshGroup.urls).sort((a, b) => parseInt(b) - parseInt(a));
                    resolutions = ['best', ...detected];
                  }
                  if (meta.resolutions) {
                    const combined = new Set([...resolutions, ...meta.resolutions]);
                    resolutions = Array.from(combined);
                  }

                  selectEl.innerHTML = '';
                  resolutions.forEach(res => {
                    const opt = document.createElement('option');
                    opt.value = res;
                    opt.textContent = res;
                    selectEl.appendChild(opt);
                  });
                }

                // Bind duration
                if (durationEl && meta.duration) {
                  durationEl.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>${meta.duration}`;
                  durationEl.style.display = 'flex';
                }
              }
            });
          }
        }
      });
    });
  }

  // Fetch M3U8 content to count duration and extract resolutions
  async function fetchHlsMetadata(key, url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'fetchHlsText', url }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          console.debug("HLS metadata pre-fetch failed (often due to CORS/Auth, which is normal): ", chrome.runtime.lastError || response?.error);
          streamMetadata[key] = { duration: '', resolutions: ['best'] };
          resolve();
          return;
        }

        try {
          const text = response.text;
          const duration = calculateM3u8Duration(text);
          const resolutions = extractM3u8Resolutions(text);
          streamMetadata[key] = {
            duration,
            resolutions: resolutions.length > 0 ? ['best', ...resolutions] : ['best']
          };
        } catch (e) {
          streamMetadata[key] = { duration: '', resolutions: ['best'] };
        }
        resolve();
      });
    });
  }

  function calculateM3u8Duration(text) {
    const matches = text.matchAll(/#EXTINF:\s*(\d+(?:\.\d+)?)/g);
    let totalSeconds = 0;
    for (const match of matches) {
      totalSeconds += parseFloat(match[1]);
    }
    if (totalSeconds === 0) return '';
    
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.round(totalSeconds % 60);
    
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    } else {
      return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
  }

  function extractM3u8Resolutions(text) {
    const matches = text.matchAll(/RESOLUTION=(\d+x\d+)/g);
    const resolutions = new Set();
    for (const match of matches) {
      const res = match[1];
      const height = res.split('x')[1];
      if (height) {
        resolutions.add(height + 'p');
      }
    }
    return Array.from(resolutions).sort((a, b) => parseInt(b) - parseInt(a));
  }



  function renderEmptyState() {
    streamsList.innerHTML = `
      <div class="empty-state">
        <div class="pulse-ring"></div>
        <svg viewBox="0 0 24 24" class="empty-icon"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H7c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.04-.42 1.99-1.07 2.75z"/></svg>
        <p>스트림 감지 대기 중...</p>
        <span>영상을 재생하면 자동으로 분석을 진행합니다.</span>
      </div>
    `;
  }

  // Grouping helper structures
  function getUrlGroupKey(url) {
    try {
      const urlObj = new URL(url);
      let path = urlObj.pathname.toLowerCase();
      
      const segments = path.split('/').filter(Boolean);
      // Filter out common structural folders so we group by the actual video ID or hash
      const meaningfulSegments = segments.filter(s => {
        // Ignore resolution-like, common media folders, language codes, and filenames
        if (/^(hls|video|audio|media|stream|master|playlist|index|variant|chunklist|track|v|a|b\d+)$/.test(s)) return false;
        if (/^(en|eng|ko|kor|ja|jpn|es|fr|ru|zh|de|it|pt)$/.test(s)) return false;
        if (s.includes('1080') || s.includes('720') || s.includes('480') || s.includes('360')) return false;
        if (s.endsWith('.m3u8') || s.endsWith('.ts')) return false;
        return true;
      });
      
      // Use the host and the first meaningful segment (usually the video ID) to group
      // If no meaningful segments, just use the host. This guarantees identical videos group together!
      let basePath = '';
      if (meaningfulSegments.length > 0) {
        basePath = '/' + meaningfulSegments[0];
      }
      
      return urlObj.host + basePath;
    } catch (e) {
      return url;
    }
  }

  function guessResolutionFromUrl(url) {
    const u = url.toLowerCase();
    // Do not guess resolution for audio tracks, even if they share a parent directory with '1080' in it
    if (u.includes('/audio') || u.includes('_audio') || u.includes('audio_')) return null;

    if (u.includes('1080') || u.includes('1920x1080')) return '1080p';
    if (u.includes('720') || u.includes('1280x720')) return '720p';
    if (u.includes('480') || u.includes('854x480')) return '480p';
    if (u.includes('360') || u.includes('640x360')) return '360p';
    if (u.includes('240') || u.includes('426x240')) return '240p';
    if (u.includes('144') || u.includes('256x144')) return '144p';
    return null;
  }

  function extractLabelFromUrl(url) {
    const u = url.toLowerCase();
    if (u.includes('/audio') || u.includes('_audio') || u.includes('audio_')) {
      const match = u.match(/\/(en|eng|ko|kor|ja|jpn|es|fr|ru|zh|de|it|pt)\//);
      if (match) return `Audio (${match[1].toUpperCase()})`;
      return 'Audio';
    }

    const res = guessResolutionFromUrl(url);
    if (res) return res;
    try {
      const segments = new URL(url).pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        let last = segments[segments.length - 1].replace('.m3u8', '').replace('.ts', '');
        if ((last === 'index' || last === 'master' || last === 'playlist') && segments.length > 1) {
          return segments[segments.length - 2] + '/' + last;
        }
        return last || 'Stream';
      }
    } catch(e) {}
    return 'Stream';
  }

  function findGroupForUrl(url) {
    return currentGroups.find(g => g.mainUrl === url || Object.values(g.urls).includes(url));
  }

  function groupStreams(m3u8List, tsList) {
    const groupList = [];

    m3u8List.forEach(url => {
      const label = extractLabelFromUrl(url);
      groupList.push({
        type: 'm3u8',
        groupKey: url,
        mainUrl: url,
        urls: { [label]: url },
        hasMaster: false
      });
    });

    tsList.forEach(url => {
      groupList.push({
        type: 'ts',
        groupKey: url,
        mainUrl: url,
        urls: { 'best': url },
        hasMaster: false
      });
    });

    return groupList;
  }

  function renderStreamsList() {
    streamsList.innerHTML = '';
    if (currentGroups.length === 0) {
      renderEmptyState();
      return;
    }

    currentGroups.forEach(group => {
      streamsList.appendChild(createStreamCard(group));
    });
  }

  // Create stream card element
  function createStreamCard(group) {
    const cardId = btoa(unescape(encodeURIComponent(group.groupKey))).replace(/=/g, '').substring(0, 32);
    
    const getFreshGroup = () => {
      return currentGroups.find(g => g.groupKey === group.groupKey) || group;
    };
    
    // Check if we have active download task running for this group
    const activeTask = Object.values(activeDownloads).find(t => 
      t.url === group.mainUrl || Object.values(group.urls).includes(t.url)
    );
    const isDownloading = !!activeTask;

    const card = document.createElement('div');
    card.className = 'stream-card';
    card.setAttribute('data-url', cardId);
    if (isDownloading) {
      card.setAttribute('data-task-id', activeTask.id);
    }

    // Dismiss button
    const btnDismiss = document.createElement('button');
    btnDismiss.className = 'card-close-btn';
    btnDismiss.title = '제거';
    btnDismiss.innerHTML = '&times;';
    btnDismiss.addEventListener('click', () => {
      if (isDownloading) {
        if (confirm('다운로드가 진행 중입니다. 취소하시겠습니까?')) {
          chrome.runtime.sendMessage({ action: 'cancelDownload', taskId: activeTask.id }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        }
      } else {
        const freshGroup = getFreshGroup();
        removeStreamFromTab(freshGroup.mainUrl, freshGroup.type);
        Object.values(freshGroup.urls).forEach(u => {
          if (u !== freshGroup.mainUrl) {
            removeStreamFromTab(u, freshGroup.type);
          }
        });
      }
    });
    card.appendChild(btnDismiss);

    // Left Thumbnail Area
    const thumbWrapper = document.createElement('div');
    thumbWrapper.className = 'card-thumb-wrapper';
    
    const playSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    playSvg.setAttribute('viewBox', '0 0 24 24');
    playSvg.setAttribute('class', 'card-thumb-icon');
    playSvg.innerHTML = `<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/>`;
    thumbWrapper.appendChild(playSvg);
    
    // Add Preview Functionality
    thumbWrapper.style.cursor = 'pointer';
    thumbWrapper.title = '미리보기 재생';
    thumbWrapper.addEventListener('click', () => {
      if (thumbWrapper.querySelector('video')) return;
      
      const video = document.createElement('video');
      video.className = 'card-preview-video';
      video.controls = true;
      video.autoplay = true;
      video.muted = true; // Auto-play requires mute
      
      // Select the URL to preview based on dropdown or mainUrl
      const freshGroup = getFreshGroup();
      let playUrl = freshGroup.mainUrl;
      const resSelect = card.querySelector('.card-resolution-select');
      if (resSelect && resSelect.value !== 'best' && freshGroup.urls[resSelect.value]) {
        playUrl = freshGroup.urls[resSelect.value];
      }

      if (freshGroup.type === 'm3u8' && typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(playUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(e => console.log('Auto-play prevented'));
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (Safari etc)
        video.src = playUrl;
        video.addEventListener('loadedmetadata', () => {
          video.play().catch(e => console.log('Auto-play prevented'));
        });
      } else {
        // Fallback for TS
        video.src = playUrl;
        video.play().catch(e => console.log('Auto-play prevented'));
      }
      
      thumbWrapper.innerHTML = '';
      thumbWrapper.appendChild(video);
    });

    // Duration Badge
    const durationBadge = document.createElement('div');
    durationBadge.className = 'card-thumb-badge';
    durationBadge.style.display = 'none';
    
    const meta = streamMetadata[group.groupKey];
    if (meta && meta.duration) {
      durationBadge.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>${meta.duration}`;
      durationBadge.style.display = 'flex';
    }
    thumbWrapper.appendChild(durationBadge);
    card.appendChild(thumbWrapper);

    // Right Content Area
    const cardMain = document.createElement('div');
    cardMain.className = 'card-main';

    // Title Row
    const titleRow = document.createElement('div');
    titleRow.className = 'card-title-row';

    const typeBadge = document.createElement('span');
    typeBadge.className = 'card-type-badge';
    typeBadge.textContent = group.type;
    titleRow.appendChild(typeBadge);

    const titleLabel = document.createElement('span');
    titleLabel.className = 'card-title';
    titleLabel.textContent = isDownloading ? activeTask.title : activeTabTitle;
    titleLabel.title = titleLabel.textContent;
    titleRow.appendChild(titleLabel);
    cardMain.appendChild(titleRow);

    // Editable input (hidden initially)
    const titleInput = document.createElement('input');
    titleInput.className = 'card-title-input';
    titleInput.type = 'text';
    titleInput.style.display = 'none';
    titleInput.value = titleLabel.textContent;
    cardMain.appendChild(titleInput);

    // Actions Row
    const actionsRow = document.createElement('div');
    actionsRow.className = 'card-actions';
    
    // Edit pencil button
    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn-card-edit';
    btnEdit.title = '이름 수정';
    btnEdit.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
    
    btnEdit.addEventListener('click', () => {
      if (titleInput.style.display === 'none') {
        titleInput.style.display = 'block';
        titleLabel.style.display = 'none';
        titleInput.focus();
        btnEdit.innerHTML = `<svg viewBox="0 0 24 24" style="fill: var(--color-success);"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
      } else {
        const newTitle = titleInput.value.trim();
        if (newTitle) {
          titleLabel.textContent = newTitle;
          titleLabel.title = newTitle;
        }
        titleInput.style.display = 'none';
        titleLabel.style.display = 'block';
        btnEdit.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
      }
    });
    
    actionsRow.appendChild(btnEdit);

    // Format badge box (mock format like MP4 container)
    const formatBox = document.createElement('div');
    formatBox.className = 'card-format-box';
    formatBox.textContent = 'MP4'; // User mockup has MP4 badge
    actionsRow.appendChild(formatBox);

    // Resolution dropdown
    const resSelect = document.createElement('select');
    resSelect.className = 'card-resolution-select';
    
    // Bind resolutions
    let resolutions = ['best'];
    if (Object.keys(group.urls).length > 0) {
      const detected = Object.keys(group.urls).sort((a, b) => parseInt(b) - parseInt(a));
      resolutions = ['best', ...detected];
    }
    
    if (meta && meta.resolutions) {
      const combined = new Set([...resolutions, ...meta.resolutions]);
      resolutions = Array.from(combined);
    }
    
    resolutions.forEach(res => {
      const opt = document.createElement('option');
      opt.value = res;
      opt.textContent = res;
      resSelect.appendChild(opt);
    });
    actionsRow.appendChild(resSelect);

    // Download Button
    const btnDownload = document.createElement('button');
    btnDownload.className = 'btn-card-download';
    btnDownload.innerHTML = `<svg viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>다운로드`;
    
    btnDownload.addEventListener('click', () => {
      const freshGroup = getFreshGroup();
      const selectedRes = resSelect.value;
      const targetTitle = titleLabel.textContent;
      const taskId = 'task_' + Date.now();
      
      let downloadUrl = freshGroup.mainUrl;
      if (selectedRes !== 'best' && freshGroup.urls[selectedRes]) {
        downloadUrl = freshGroup.urls[selectedRes];
      }
      
      // Update local card mapping to this task ID
      card.setAttribute('data-task-id', taskId);
      
      // Request download from background
      chrome.runtime.sendMessage({
        action: 'startDownload',
        taskId,
        url: downloadUrl,
        title: targetTitle,
        type: freshGroup.type,
        resolution: selectedRes
      }, () => {
        // Toggle view to downloading state
        actionsRow.style.display = 'none';
        cardMain.appendChild(createProgressLayout(taskId));
        getActiveDownloads(); // refresh
      });
    });

    actionsRow.appendChild(btnDownload);
    cardMain.appendChild(actionsRow);

    // If already downloading, render the progress UI instead of controls row
    if (isDownloading) {
      actionsRow.style.display = 'none';
      cardMain.appendChild(createProgressLayout(activeTask.id));
      // Trigger initial progress paint from cache
      setTimeout(() => updateProgressUI(activeTask), 50);
    }

    card.appendChild(cardMain);
    return card;
  }

  // Create card progress layout elements
  function createProgressLayout(taskId) {
    const layout = document.createElement('div');
    layout.className = 'card-progress-layout';
    layout.setAttribute('data-progress-layout', taskId);

    const infoRow = document.createElement('div');
    infoRow.className = 'progress-info';

    const stateText = document.createElement('span');
    stateText.className = 'progress-state-text';
    stateText.textContent = '대기 중...';
    infoRow.appendChild(stateText);

    const percentText = document.createElement('span');
    percentText.className = 'progress-percent';
    percentText.textContent = '0%';
    infoRow.appendChild(percentText);
    layout.appendChild(infoRow);

    const progressBg = document.createElement('div');
    progressBg.className = 'card-progress-bg';
    
    const progressFill = document.createElement('div');
    progressFill.className = 'card-progress-fill';
    progressBg.appendChild(progressFill);
    layout.appendChild(progressBg);

    const statsRow = document.createElement('div');
    statsRow.className = 'progress-stats-row';

    const statText = document.createElement('span');
    statText.className = 'progress-stat';
    statText.textContent = '0 / 0 | 0.0 MB/s';
    statsRow.appendChild(statText);

    const actions = document.createElement('div');
    actions.className = 'progress-actions';

    const btnPauseTask = document.createElement('button');
    btnPauseTask.className = 'btn-mini-action pause-btn';
    btnPauseTask.textContent = '일시정지';
    
    // Toggle pause/resume in background
    btnPauseTask.addEventListener('click', () => {
      const activeTask = activeDownloads[taskId];
      if (activeTask) {
        if (activeTask.state === 'downloading') {
          chrome.runtime.sendMessage({ action: 'pauseDownload', taskId }, () => {
            btnPauseTask.textContent = '재개';
          });
        } else if (activeTask.state === 'paused') {
          chrome.runtime.sendMessage({ action: 'startDownload', taskId, url: activeTask.url, title: activeTask.title, type: activeTask.type, resolution: activeTask.resolution }, () => {
            btnPauseTask.textContent = '일시정지';
          });
        }
      }
    });

    const btnCancelTask = document.createElement('button');
    btnCancelTask.className = 'btn-mini-action cancel';
    btnCancelTask.textContent = '취소';
    btnCancelTask.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'cancelDownload', taskId }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    });

    actions.appendChild(btnPauseTask);
    actions.appendChild(btnCancelTask);
    statsRow.appendChild(actions);
    layout.appendChild(statsRow);

    return layout;
  }

  // Update card progress bar & text in real-time
  function updateProgressUI(task) {
    if (!task) return;
    
    // Sync to local activeDownloads list
    activeDownloads[task.id] = task;

    const card = document.querySelector(`[data-task-id="${task.id}"]`);
    if (!card) return;

    const layout = card.querySelector(`[data-progress-layout="${task.id}"]`);
    if (!layout) return;

    const stateText = layout.querySelector('.progress-state-text');
    const percentText = layout.querySelector('.progress-percent');
    const progressFill = layout.querySelector('.card-progress-fill');
    const statText = layout.querySelector('.progress-stat');
    const btnPauseTask = layout.querySelector('.pause-btn');

    // State mapping
    let stateLabel = '다운로드 중...';
    if (task.state === 'parsing') stateLabel = '재생목록 분석 중...';
    else if (task.state === 'paused') {
      stateLabel = '일시정지됨';
      if (btnPauseTask) btnPauseTask.textContent = '재개';
    } else if (task.state === 'merging') {
      stateLabel = '병합 중...';
    } else if (task.state === 'saving') {
      stateLabel = '저장 대기 중...';
    } else if (task.state === 'completed') {
      stateLabel = '완료됨';
      delete activeDownloads[task.id];
      // Rerender lists to clean card and add to completed history
      loadStreams();
      loadCompletedHistory();
      return;
    } else if (task.state === 'error') {
      stateLabel = '에러';
      alert(`다운로드 실패: ${task.errorMsg}`);
      chrome.runtime.sendMessage({ action: 'cancelDownload', taskId: task.id }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
      return;
    }

    if (stateText) stateText.textContent = stateLabel;
    if (percentText) percentText.textContent = `${task.progress.toFixed(1)}%`;
    if (progressFill) progressFill.style.width = `${task.progress}%`;
    
    if (statText) {
      statText.textContent = `${task.downloadedCount} / ${task.totalSegments} 조각 | ${task.speed.toFixed(1)} MB/s (남음: ${task.eta})`;
    }
  }

  // Remove stream from active tab list
  function removeStreamFromTab(url, type) {
    chrome.runtime.sendMessage({ action: 'deleteStream', tabId: activeTabId, url, type }, () => {
      loadStreams();
    });
  }

  // Rerender streams list minus one URL
  // Wait, let's add deleteStream in background.js so we can delete a single stream.
  
  // Clear Active streams
  btnClear.addEventListener('click', () => {
    if (activeTabId) {
      chrome.runtime.sendMessage({ action: 'clearStreams', tabId: activeTabId }, (response) => {
        if (response && response.success) {
          loadStreams();
        }
      });
    }
  });

  // Manual Input Trigger
  btnManualDownload.addEventListener('click', () => {
    triggerManualUrl();
  });

  manualUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      triggerManualUrl();
    }
  });

  function triggerManualUrl() {
    const url = manualUrlInput.value.trim();
    if (!url) return;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      alert('올바른 HTTP/HTTPS URL을 입력해주세요.');
      return;
    }

    let type = 'm3u8';
    if (url.includes('.ts') || url.includes('/ts/')) {
      type = 'ts';
    }

    // Add manually to stream cache
    // Let's send to background to add it to detectedStreams
    // We can add a 'addManualStream' message in background.js.
    chrome.runtime.sendMessage({ action: 'addManualStream', tabId: activeTabId, url, type }, () => {
      loadStreams();
    });
    manualUrlInput.value = '';
  }

  // 완료 (Completed downloads history)
  async function loadCompletedHistory() {
    chrome.storage.local.get({ completedDownloads: [] }, (res) => {
      const list = res.completedDownloads || [];
      renderCompletedList(list);
    });
  }

  function renderCompletedList(list) {
    if (list.length === 0) {
      completedList.innerHTML = `<div class="completed-empty">완료된 다운로드가 없습니다.</div>`;
      return;
    }

    completedList.innerHTML = '';
    list.forEach(item => {
      const card = document.createElement('div');
      card.className = 'completed-card';

      const title = document.createElement('div');
      title.className = 'comp-title';
      title.textContent = item.title || item.filename;
      title.title = title.textContent;
      card.appendChild(title);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'comp-actions-row';

      const badge = document.createElement('span');
      badge.className = 'comp-badge';
      badge.textContent = item.domain;
      actionsRow.appendChild(badge);

      const buttons = document.createElement('div');
      buttons.className = 'comp-btns';

      // Trash Button
      const btnTrash = document.createElement('button');
      btnTrash.className = 'btn-comp-icon delete';
      btnTrash.title = '이력에서 삭제';
      btnTrash.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
      btnTrash.addEventListener('click', () => {
        deleteFromCompletedHistory(item.id);
      });
      buttons.appendChild(btnTrash);

      // Folder Button
      const btnFolder = document.createElement('button');
      btnFolder.className = 'btn-comp-icon';
      btnFolder.title = '폴더 열기';
      btnFolder.innerHTML = `<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
      btnFolder.addEventListener('click', () => {
        chrome.downloads.show(item.downloadId);
      });
      buttons.appendChild(btnFolder);

      // Play Button
      const btnPlay = document.createElement('button');
      btnPlay.className = 'btn-comp-play';
      btnPlay.title = '동영상 재생';
      btnPlay.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>재생`;
      btnPlay.addEventListener('click', () => {
        chrome.downloads.open(item.downloadId);
      });
      buttons.appendChild(btnPlay);

      actionsRow.appendChild(buttons);
      card.appendChild(actionsRow);
      completedList.appendChild(card);
    });
  }

  function deleteFromCompletedHistory(id) {
    chrome.storage.local.get({ completedDownloads: [] }, (res) => {
      let list = res.completedDownloads || [];
      list = list.filter(item => item.id !== id);
      chrome.storage.local.set({ completedDownloads: list }, () => {
        loadCompletedHistory();
      });
    });
  }

  // Footer Actions
  btnHideHistory.addEventListener('click', () => {
    if (completedList.style.display === 'none') {
      completedList.style.display = 'flex';
      btnHideHistory.textContent = '숨기기';
    } else {
      completedList.style.display = 'none';
      btnHideHistory.textContent = '보이기';
    }
  });

  btnClearHistory.addEventListener('click', () => {
    if (confirm('모든 다운로드 완료 이력을 비우시겠습니까? (실제 파일은 삭제되지 않습니다)')) {
      chrome.storage.local.set({ completedDownloads: [] }, () => {
        loadCompletedHistory();
      });
    }
  });

  // Filter out TS files when m3u8 playlists exist, and only keep 1 representative TS file per directory/base path
  function filterTsStreams(tsList, m3u8List) {
    if (tsList.length === 0) return [];
    
    // Extract hosts of detected m3u8 playlists
    const m3u8Hosts = new Set();
    m3u8List.forEach(url => {
      try {
        m3u8Hosts.add(new URL(url).host);
      } catch(e) {}
    });

    const uniqueTs = [];
    const seenBasePaths = new Set();

    tsList.forEach(url => {
      try {
        const urlObj = new URL(url);
        // Hide TS files if there's already an HLS playlist on the same host
        if (m3u8Hosts.has(urlObj.host)) {
          return;
        }

        // Extract folder base path (e.g. host + path up to last slash)
        const basePath = urlObj.host + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/'));
        
        if (!seenBasePaths.has(basePath)) {
          seenBasePaths.add(basePath);
          uniqueTs.push(url);
        }
      } catch(e) {
        uniqueTs.push(url);
      }
    });

    return uniqueTs;
  }
});
