// Stream list helpers shared by background.js (importScripts) and tests (node).
// Pure functions only: no chrome.* API here.

// Origin + path without query (tokens / cache busters change on every request)
function pathKeyOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (e) {
    return url;
  }
}

// Parse playlist text into what we need to group streams.
//   master: { kind, variants: [{ url, path, resolution, bandwidth }], resolutions }
//   media : { kind, fp, segments, duration }   fp = first segment path + segment count
function parsePlaylist(text, baseUrl) {
  if (!text || !text.trim().startsWith('#EXTM3U')) return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const resolve = (u) => {
    try { return new URL(u, baseUrl).href; } catch (e) { return u; }
  };

  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const next = lines.slice(i + 1).find(l => !l.startsWith('#'));
    if (!next) continue;
    const url = resolve(next);
    const resMatch = lines[i].match(/RESOLUTION=\d+x(\d+)/);
    const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
    variants.push({
      url,
      path: pathKeyOf(url),
      resolution: resMatch ? resMatch[1] + 'p' : '',
      bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0
    });
  }
  if (variants.length > 0) {
    const resolutions = Array.from(new Set(variants.map(v => v.resolution).filter(Boolean)))
      .sort((a, b) => parseInt(b) - parseInt(a));
    return { kind: 'master', variants, resolutions };
  }

  let duration = 0;
  let segments = 0;
  let first = '';
  for (const line of lines) {
    const inf = line.match(/^#EXTINF:\s*(\d+(?:\.\d+)?)/);
    if (inf) duration += parseFloat(inf[1]);
    else if (!line.startsWith('#')) {
      if (!first) first = pathKeyOf(resolve(line));
      segments++;
    }
  }
  return { kind: 'media', fp: first ? first + '#' + segments : '', segments, duration };
}

function formatDuration(totalSeconds) {
  if (!totalSeconds) return '';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Same master (same variant set) / same media content / otherwise same path -> same video
function identityOf(url, info) {
  const i = info[url];
  if (i && i.kind === 'master') return 'master:' + i.variants.map(v => v.path).sort().join('|');
  if (i && i.kind === 'media' && i.fp) return 'media:' + i.fp;
  return 'path:' + pathKeyOf(url);
}

// Direct video files (no merging needed). Fragments of adaptive players (.m4s, MSE chunks) are not files.
const VIDEO_FILE_EXT = /\.(mp4|m4v|webm|mov)$/i;

function videoFileExt(url, contentType) {
  let path = '';
  try { path = new URL(url).pathname; } catch (e) { path = url; }
  const m = path.match(VIDEO_FILE_EXT);
  if (m) return m[1].toLowerCase();
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('video/webm')) return 'webm';
  if (ct.includes('video/quicktime')) return 'mov';
  if (ct.includes('video/mp4') || ct.includes('video/x-m4v')) return 'mp4';
  return '';
}

// Total size from Content-Range ("bytes 0-1023/52428800") or Content-Length of a full response
function totalSizeOf(headers, statusCode) {
  const get = (name) => {
    const h = (headers || []).find(x => x.name.toLowerCase() === name);
    return h ? h.value : '';
  };
  const range = get('content-range').match(/\/(\d+)\s*$/);
  if (range) return parseInt(range[1], 10);
  const len = parseInt(get('content-length'), 10);
  return statusCode === 200 && len > 0 ? len : 0;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// Collapse raw captured URLs into one entry per video.
//   m3u8Urls / tsUrls / fileUrls: oldest first (later = fresher token)
//   info: { [url]: parsePlaylist() result | { kind: 'file', ext, size } }
// Rules
//   1. Same master (same variant set) / same media content (fp) / same path -> one entry, latest URL wins
//   2. Media playlists referenced by a master are folded into that master (pick them via resolution)
//   3. TS segments are hidden when the tab has any playlist; otherwise one per folder
//   4. Video files: one per path; 3+ different files in one folder are numbered fragments -> hidden
// Returns { m3u8: [url], ts: [url], file: [url], meta: { [url]: { duration, resolutions, size, ext } } }
function collapseStreams(m3u8Urls, tsUrls, info, fileUrls = []) {
  const identity = (url) => identityOf(url, info);

  const variantPaths = new Set();
  m3u8Urls.forEach(url => {
    const i = info[url];
    if (i && i.kind === 'master') i.variants.forEach(v => variantPaths.add(v.path));
  });

  const latest = new Map(); // identity -> url (Map keeps first-seen order, value is the newest URL)
  m3u8Urls.forEach(url => {
    const i = info[url];
    if (!(i && i.kind === 'master') && variantPaths.has(pathKeyOf(url))) return;
    latest.set(identity(url), url);
  });
  const m3u8 = Array.from(latest.values());

  // Master has no #EXTINF: borrow the duration of any of its variants we have parsed
  const durationByPath = {};
  m3u8Urls.forEach(url => {
    const i = info[url];
    if (i && i.kind === 'media' && i.duration) durationByPath[pathKeyOf(url)] = i.duration;
  });
  const meta = {};
  m3u8.forEach(url => {
    const i = info[url];
    if (!i) return;
    if (i.kind === 'master') {
      const v = i.variants.find(x => durationByPath[x.path]);
      meta[url] = { duration: formatDuration(v ? durationByPath[v.path] : 0), resolutions: i.resolutions };
    } else {
      meta[url] = { duration: formatDuration(i.duration), resolutions: [] };
    }
  });

  let ts = [];
  if (m3u8Urls.length === 0) {
    const byFolder = new Map();
    tsUrls.forEach(url => {
      const p = pathKeyOf(url);
      byFolder.set(p.substring(0, p.lastIndexOf('/') + 1), url);
    });
    ts = Array.from(byFolder.values());
  }

  const fileByPath = new Map();
  fileUrls.forEach(url => fileByPath.set(pathKeyOf(url), url));
  const filesPerFolder = {};
  fileByPath.forEach((url, p) => {
    const folder = p.substring(0, p.lastIndexOf('/') + 1);
    filesPerFolder[folder] = (filesPerFolder[folder] || 0) + 1;
  });
  const file = [];
  fileByPath.forEach((url, p) => {
    if (filesPerFolder[p.substring(0, p.lastIndexOf('/') + 1)] >= 3) return;
    file.push(url);
    const i = info[url] || {};
    meta[url] = { duration: '', resolutions: [], size: formatSize(i.size), ext: i.ext || videoFileExt(url) || 'mp4' };
  });

  return { m3u8, ts, file, meta };
}

// YouTube is not supported (Chrome Web Store policy): not detected, not downloadable
const BLOCKED_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|googlevideo\.com|youtu\.be)$/i;

function isBlockedUrl(url) {
  try {
    return BLOCKED_HOSTS.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

// Raw URLs that are shown as the same entry as `url` (same identity, or variants of that master)
function relatedUrls(url, urls, info) {
  const i = info[url];
  const variantPaths = new Set(i && i.kind === 'master' ? i.variants.map(v => v.path) : []);
  const id = identityOf(url, info);
  return urls.filter(u => u === url || identityOf(u, info) === id || variantPaths.has(pathKeyOf(u)));
}

if (typeof module !== 'undefined') {
  module.exports = {
    pathKeyOf, parsePlaylist, formatDuration, collapseStreams, relatedUrls, isBlockedUrl,
    videoFileExt, totalSizeOf, formatSize
  };
}
