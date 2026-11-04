// Store images per language -> store/assets/<lang>/
//   popup-<scene>.png (450x720 x2, the real popup via popup-demo.html), screenshot-1..3.png (1280x800), promo-small.png (440x280)
// usage: node store/assets/build-demo.js && node store/assets/build-shots.js [lang ...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FONTS = {
  ko: "'Malgun Gothic'",
  en: "'Segoe UI'",
  ja: "'Yu Gothic UI', 'Meiryo'",
  zh_CN: "'Microsoft YaHei'",
  zh_TW: "'Microsoft JhengHei'"
};

// [badge, title, body] per screenshot, then the promo tile line
const TEXT = {
  ko: {
    shots: [
      ['자동 감지', '재생 중인 영상을<br>한 줄로 정리해 보여줍니다', 'HLS(.m3u8) 스트림과 MP4·WebM 파일을 감지하고<br>화질별 재생목록은 하나로 묶어<br>원하는 화질을 골라 받을 수 있습니다.'],
      ['한 파일로 저장', '조각난 스트림을<br>MP4 한 파일로 합칩니다', '진행률·속도·남은 시간을 보여주고<br>일시정지·재개·취소할 수 있습니다.<br>팝업을 닫아도 다운로드는 계속됩니다.'],
      ['정책 준수', 'YouTube·DRM 영상은<br>지원하지 않습니다', 'YouTube 에서는 감지하지 않고 안내만 표시하며<br>DRM 으로 보호된 영상은 받지 않습니다.<br>권리가 있는 영상만 저장하세요.']
    ],
    promo: 'HLS · MP4 영상을 감지해 한 파일로 저장'
  },
  en: {
    shots: [
      ['Auto-detect', 'Every playing video,<br>listed once', 'Detects HLS (.m3u8) streams and MP4/WebM files,<br>groups the quality variants into one entry<br>and lets you pick the quality you want.'],
      ['One file', 'Segmented streams<br>saved as one MP4', 'Shows progress, speed and time left,<br>with pause, resume and cancel.<br>Downloads keep going when the popup is closed.'],
      ['Store policy', 'YouTube and DRM videos<br>are not supported', 'On YouTube it detects nothing and shows a notice.<br>DRM-protected videos are never downloaded.<br>Only save videos you have the rights to.']
    ],
    promo: 'Detect HLS · MP4 videos and save them as one file'
  },
  ja: {
    shots: [
      ['自動検出', '再生中の動画を<br>1行にまとめて表示', 'HLS (.m3u8) ストリームと<br>MP4・WebM ファイルを検出し、<br>画質ごとのプレイリストを1つにまとめて<br>好きな画質を選んで保存できます。'],
      ['1つのファイルに保存', '分割されたストリームを<br>1つの MP4 にまとめます', '進捗・速度・残り時間を表示し、<br>一時停止・再開・キャンセルができます。<br>ポップアップを閉じてもダウンロードは続きます。'],
      ['ポリシー遵守', 'YouTube・DRM 動画には<br>対応していません', 'YouTube では検出せず案内のみ表示し、<br>DRM で保護された動画は保存しません。<br>権利のある動画だけを保存してください。']
    ],
    promo: 'HLS・MP4 動画を検出して1つのファイルに保存'
  },
  zh_CN: {
    shots: [
      ['自动检测', '正在播放的视频<br>整理成一行显示', '检测 HLS (.m3u8) 视频流和 MP4/WebM 文件，<br>将不同画质的播放列表合并为一项，<br>可选择想要的画质下载。'],
      ['保存为一个文件', '分片的视频流<br>合并为一个 MP4', '显示进度、速度和剩余时间，<br>可暂停、继续和取消。<br>关闭弹窗后下载仍会继续。'],
      ['遵守政策', '不支持 YouTube<br>和 DRM 视频', '在 YouTube 上不检测，只显示提示，<br>受 DRM 保护的视频不会下载。<br>请只保存您有权保存的视频。']
    ],
    promo: '检测 HLS · MP4 视频并保存为一个文件'
  },
  zh_TW: {
    shots: [
      ['自動偵測', '正在播放的影片<br>整理成一行顯示', '偵測 HLS (.m3u8) 串流和 MP4/WebM 檔案，<br>將不同畫質的播放清單合併為一項，<br>可選擇想要的畫質下載。'],
      ['儲存為單一檔案', '分段的串流<br>合併為一個 MP4', '顯示進度、速度和剩餘時間，<br>可暫停、繼續和取消。<br>關閉彈出視窗後下載仍會繼續。'],
      ['遵守政策', '不支援 YouTube<br>和 DRM 影片', '在 YouTube 上不偵測，只顯示提示，<br>受 DRM 保護的影片不會下載。<br>請只儲存您有權儲存的影片。']
    ],
    promo: '偵測 HLS · MP4 影片並儲存為單一檔案'
  }
};

// screenshot n shows this popup scene, cropped to the scene's content height
const SCENES = [['list', 608], ['downloading', 624], ['youtube', 572]];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mediadown-shots-'));
function capture(file, query, out, width, height, scale) {
  const url = 'file:///' + path.resolve(__dirname, file).replace(/\\/g, '/') + (query || '');
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--user-data-dir=' + profile, '--virtual-time-budget=3000',
    '--force-device-scale-factor=' + scale, '--window-size=' + width + ',' + height,
    '--screenshot=' + out, url
  ], { stdio: 'ignore' });
}

const langs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TEXT);
for (const lang of langs) {
  const t = TEXT[lang];
  const dir = path.join(__dirname, lang);
  fs.mkdirSync(dir, { recursive: true });
  const htmlLang = lang.replace('_', '-');
  const font = `<style>body { font-family: ${FONTS[lang]}, sans-serif; }</style>`;

  SCENES.forEach(([scene, height], i) => {
    capture('popup-demo.html', `?scene=${scene}&lang=${lang}`, path.join(dir, `popup-${scene}.png`), 450, 720, 2);
    const [badge, title, body] = t.shots[i];
    const html = `<!doctype html><html lang="${htmlLang}"><head><meta charset="utf-8"><link rel="stylesheet" href="../shot.css">${font}</head><body>
<div class="text"><span class="badge">${badge}</span><h1>${title}</h1><p>${body}</p></div>
<div class="shot" style="height: ${height}px"><img src="popup-${scene}.png" alt=""></div>
</body></html>
`;
    fs.writeFileSync(path.join(dir, `screenshot-${i + 1}.html`), html);
    capture(`${lang}/screenshot-${i + 1}.html`, '', path.join(dir, `screenshot-${i + 1}.png`), 1280, 800, 1);
  });

  const promo = fs.readFileSync(path.join(__dirname, 'promo-small.html'), 'utf8')
    .replace('lang="ko"', `lang="${htmlLang}"`)
    .replace("'Malgun Gothic'", FONTS[lang])
    .replace('../../icons/', '../../../icons/')
    .replace(/<div class="desc">.*<\/div>/, `<div class="desc">${t.promo}</div>`);
  fs.writeFileSync(path.join(dir, 'promo-small.html'), promo);
  capture(`${lang}/promo-small.html`, '', path.join(dir, 'promo-small.png'), 440, 280, 1);
  console.log(lang + ' done');
}
fs.rmSync(profile, { recursive: true, force: true });
