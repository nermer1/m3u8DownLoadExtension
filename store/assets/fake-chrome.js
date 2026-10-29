// Fake chrome.* API + sample data so the real popup can be rendered for store screenshots.
//   popup-demo.html?scene=list | downloading | youtube
(function () {
  const scene = new URLSearchParams(location.search).get('scene') || 'list';
  const HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  const FILE = 'https://upload.wikimedia.org/wikipedia/commons/sample/Big_Buck_Bunny.webm';
  const tab = scene === 'youtube'
    ? { id: 1, title: 'YouTube', url: 'https://www.youtube.com/watch?v=demo' }
    : { id: 1, title: 'Big Buck Bunny (open movie)', url: 'https://hlsjs.video-dev.org/demo/' };

  const streams = scene === 'youtube' ? { m3u8: [], ts: [], file: [], meta: {} } : {
    m3u8: [HLS], ts: [], file: [FILE],
    meta: {
      [HLS]: { duration: '10:34', resolutions: ['1080p', '720p', '480p', '360p'] },
      [FILE]: { duration: '', resolutions: [], size: '148 MB', ext: 'webm' }
    }
  };
  const downloads = scene === 'downloading' ? {
    task_1: { id: 'task_1', url: HLS, title: 'Big Buck Bunny (open movie)', type: 'm3u8', resolution: '1080p',
      state: 'downloading', progress: 62.4, speed: 8.6, eta: '00:21', downloadedCount: 397, totalSegments: 636 }
  } : {};
  const completed = [
    { id: 'c1', downloadId: 1, title: 'Sintel (open movie)', filename: 'Sintel.mp4', domain: 'download.blender.org' },
    { id: 'c2', downloadId: 2, title: 'Tears of Steel (open movie)', filename: 'Tears of Steel.mp4', domain: 'test-streams.mux.dev' }
  ];

  window.chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage(msg, cb) {
        const res = msg.action === 'getStreams' ? streams
          : msg.action === 'getActiveDownloads' ? { activeDownloads: downloads }
          : { success: false };
        if (cb) setTimeout(() => cb(res), 0);
      }
    },
    tabs: { query: async () => [tab] },
    storage: {
      local: {
        get(defaults, cb) {
          const v = Object.assign({}, defaults, { completedDownloads: completed });
          if (cb) { cb(v); return; }
          return Promise.resolve(v);
        },
        set() { return Promise.resolve(); }
      },
      onChanged: { addListener() {} }
    },
    downloads: { search: async () => [{ id: 1 }], show() {}, open() {}, showDefaultFolder() {} }
  };
})();
