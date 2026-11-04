# Chrome 웹스토어 제출 자료 — MediaDown

개발자 대시보드에서 탭별로 그대로 복사해 넣는다.
업로드 zip: `dist/mediadown-<버전>.zip` (README "웹스토어 패키지"). 이미지: `store/assets/<언어>/*.png` (ko·en·ja·zh_CN·zh_TW).
이미지 다시 만들기: `node store/assets/build-demo.js && node store/assets/build-shots.js` — 실제 팝업(`popup-demo.html?scene=…&lang=…`)을 headless 크롬으로 언어별 캡처 → 캡처 화면·프로모션 타일까지 생성. 캡처 문구는 `build-shots.js` 의 `TEXT`.

---

## 1. 패키지

- 새 항목 → `dist/mediadown-1.2.zip` 업로드
- 업데이트(1.3) → 패키지 탭에서 `dist/mediadown-1.3.zip` 새 패키지 업로드 → 개인정보 보호 관행 탭에 `declarativeNetRequestWithHostAccess` 사유 추가 → 제출
- 업데이트(1.4) → 패키지 탭에서 `dist/mediadown-1.4.zip` 새 패키지 업로드 → 제출 (권한 변경 없음, 1단계 체크 해제·자동 게시 체크 유지)
- 업데이트(1.5, 다국어) → 패키지 업로드 → 스토어 등록정보 탭에서 아래 "언어별 등록정보" 대로 언어 추가 → 제출 (권한 변경 없음)

## 2. 스토어 등록정보

언어마다 설명·캡처 화면·프로모션 타일을 따로 넣는다. 이름은 모든 언어에서 같고, 짧은 설명은 manifest(`__MSG_appDesc__`)에서 언어별로 자동으로 나온다.

| 대시보드 언어 | 설명 | 이미지 폴더 |
|---|---|---|
| English (기본 언어로 지정 권장 — 지원하지 않는 언어 사용자에게 보임) | 설명 (English) | `store/assets/en/` |
| 한국어 | 설명 (한국어) | `store/assets/ko/` |
| 日本語 | 설명 (日本語) | `store/assets/ja/` |
| 中文（简体） | 설명 (中文简体) | `store/assets/zh_CN/` |
| 中文（繁體） | 설명 (中文繁體) | `store/assets/zh_TW/` |

각 폴더의 `screenshot-1.png`~`screenshot-3.png` → 캡처 화면, `promo-small.png` → 작은 프로모션 타일.

**설명 (한국어)**

```
웹페이지에서 재생되는 영상을 감지해 한 파일로 저장하는 다운로더입니다.

■ 지원 형식
- HLS 스트림(.m3u8) / TS 조각: 조각을 받아 MP4 한 파일로 합쳐 저장
  색인이 앞에 있는 일반 MP4로 저장해 플레이어에서 앞뒤 이동이 빠릅니다
- MP4 · WebM · MOV 영상 파일: 크롬 기본 다운로드로 저장

■ 기능
- 자동 감지: 영상을 재생하면 팝업에 목록이 표시됩니다
- 같은 영상은 한 줄로: 화질별 재생목록·토큰만 다른 주소를 하나로 묶어 보여줍니다
- 화질 선택: 여러 화질을 제공하는 스트림은 원하는 화질을 골라 받을 수 있습니다
- 진행률·속도·남은 시간 표시, 일시정지·재개·취소
- 팝업을 닫아도 다운로드는 계속되고, 다시 열면 진행 상태가 그대로 보입니다
- 미리보기 재생, 파일 이름 수정, 주소 직접 입력
- 완료 목록에서 폴더 열기·바로 재생
- 한국어·영어·일본어·중국어 화면 (브라우저 언어를 따름)

■ 지원하지 않는 것
- YouTube 영상 (Chrome 웹스토어 정책)
- DRM으로 보호된 영상
- 일부 사이트는 자체 보호 설정으로 다운로드가 거부될 수 있습니다

■ 개인정보
- 어떤 데이터도 수집하거나 외부로 보내지 않습니다. 분석·광고·추적 코드가 없습니다.
- 감지한 주소와 완료 목록은 브라우저 안에만 저장됩니다.

※ 저작권이 있는 영상은 권리자의 허락 없이 저장·배포할 수 없습니다. 권리가 있는 영상만 저장하세요.
```

**설명 (English)**

```
A downloader that detects videos playing on a web page and saves them as a single file.

■ Supported formats
- HLS streams (.m3u8) / TS segments: downloads the segments and joins them into one MP4
  Saved as a regular MP4 with the index at the front, so seeking in your player is fast
- MP4 · WebM · MOV files: saved with Chrome's own downloader

■ Features
- Auto-detect: play a video and it shows up in the popup
- One entry per video: quality variants and URLs that differ only by a token are grouped together
- Quality choice: pick the quality you want when a stream offers several
- Progress, speed and time left, with pause, resume and cancel
- Downloads keep running when the popup is closed, and the progress is still there when you reopen it
- Preview playback, rename before saving, enter a URL directly
- Open the folder or play the file from the completed list
- English, Korean, Japanese and Chinese interface (follows the browser language)

■ Not supported
- YouTube videos (Chrome Web Store policy)
- DRM-protected videos
- Some sites refuse downloads with their own protection settings

■ Privacy
- Collects nothing and sends nothing anywhere. No analytics, ads or tracking code.
- Detected URLs and the completed list are stored only in your browser.

※ Copyrighted videos may not be saved or shared without the rights holder's permission. Only save videos you have the rights to.
```

**설명 (日本語)**

```
Web ページで再生中の動画を検出し、1つのファイルとして保存するダウンローダーです。

■ 対応形式
- HLS ストリーム (.m3u8) / TS セグメント：セグメントを取得して1つの MP4 に結合して保存
  インデックスが先頭にある通常の MP4 として保存するため、プレーヤーでのシークが速くなります
- MP4・WebM・MOV 動画ファイル：Chrome 標準のダウンロードで保存

■ 機能
- 自動検出：動画を再生するとポップアップに一覧が表示されます
- 同じ動画は1行に：画質ごとのプレイリストやトークンだけが違う URL を1つにまとめて表示します
- 画質の選択：複数の画質がある場合は好きな画質を選んで保存できます
- 進捗・速度・残り時間の表示、一時停止・再開・キャンセル
- ポップアップを閉じてもダウンロードは続き、開き直すと進捗がそのまま表示されます
- プレビュー再生、ファイル名の変更、URL の直接入力
- 完了一覧からフォルダを開く・すぐに再生
- 日本語・英語・韓国語・中国語の画面（ブラウザの言語に合わせて表示）

■ 対応していないもの
- YouTube の動画（Chrome ウェブストアのポリシー）
- DRM で保護された動画
- 一部のサイトは独自の保護設定によりダウンロードが拒否される場合があります

■ プライバシー
- データを収集したり外部へ送信したりすることは一切ありません。分析・広告・トラッキングのコードもありません。
- 検出した URL と完了一覧はブラウザ内にのみ保存されます。

※ 著作権のある動画を権利者の許可なく保存・配布することはできません。権利のある動画だけを保存してください。
```

**설명 (中文简体)**

```
检测网页中正在播放的视频，并保存为单个文件的下载工具。

■ 支持的格式
- HLS 视频流 (.m3u8) / TS 分片：下载分片并合并为一个 MP4 文件
  保存为索引位于开头的常规 MP4，在播放器中拖动进度更快
- MP4 · WebM · MOV 视频文件：使用 Chrome 自带的下载功能保存

■ 功能
- 自动检测：播放视频后，弹窗中会显示列表
- 同一视频显示为一项：将不同画质的播放列表、仅令牌不同的地址合并显示
- 选择画质：提供多种画质时，可选择想要的画质下载
- 显示进度、速度和剩余时间，可暂停、继续、取消
- 关闭弹窗后下载仍会继续，重新打开时进度照常显示
- 预览播放、修改文件名、直接输入地址
- 在已完成列表中打开文件夹、直接播放
- 中文、英语、韩语、日语界面（跟随浏览器语言）

■ 不支持
- YouTube 视频（Chrome 应用商店政策）
- 受 DRM 保护的视频
- 部分网站可能因自身的保护设置而拒绝下载

■ 隐私
- 不收集任何数据，也不向外部发送。没有分析、广告或跟踪代码。
- 检测到的地址和已完成列表只保存在浏览器中。

※ 未经权利人许可，不得保存或传播受版权保护的视频。请只保存您有权保存的视频。
```

**설명 (中文繁體)**

```
偵測網頁中正在播放的影片，並儲存為單一檔案的下載工具。

■ 支援的格式
- HLS 串流 (.m3u8) / TS 片段：下載片段並合併為一個 MP4 檔案
  儲存為索引位於開頭的一般 MP4，在播放器中拖曳進度更快
- MP4 · WebM · MOV 影片檔案：使用 Chrome 內建的下載功能儲存

■ 功能
- 自動偵測：播放影片後，彈出視窗中會顯示清單
- 同一部影片顯示為一項：將不同畫質的播放清單、僅權杖不同的網址合併顯示
- 選擇畫質：提供多種畫質時，可選擇想要的畫質下載
- 顯示進度、速度和剩餘時間，可暫停、繼續、取消
- 關閉彈出視窗後下載仍會繼續，重新開啟時進度照常顯示
- 預覽播放、修改檔案名稱、直接輸入網址
- 在已完成清單中開啟資料夾、直接播放
- 中文、英文、韓文、日文介面（跟隨瀏覽器語言）

■ 不支援
- YouTube 影片（Chrome 線上應用程式商店政策）
- 受 DRM 保護的影片
- 部分網站可能因自身的保護設定而拒絕下載

■ 隱私
- 不收集任何資料，也不向外部傳送。沒有分析、廣告或追蹤程式碼。
- 偵測到的網址和已完成清單只儲存在瀏覽器中。

※ 未經權利人許可，不得儲存或散布受版權保護的影片。請只儲存您有權儲存的影片。
```

- **카테고리**: 도구 (Tools) — 목록에 없으면 가장 가까운 "생산성"
- **언어**: 위 표 (기본 언어 English 권장)
- **스토어 아이콘 128×128**: `icons/icon128.png` (모든 언어 공통)
- **캡처 화면 (1280×800)**: `store/assets/<언어>/screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png`
- **작은 프로모션 타일 (440×280)**: `store/assets/<언어>/promo-small.png`
- **마키 프로모션 타일**: 비워 둠
- **YouTube 동영상**: (선택) 데모 영상을 찍으면 링크
- **홈페이지 URL**: https://github.com/nermer1/m3u8DownLoadExtension
- **지원 URL**: https://github.com/nermer1/m3u8DownLoadExtension/issues

## 3. 개인정보 보호 관행

**단일 목적**

```
Detects videos played on the current web page (HLS .m3u8/.ts streams and MP4/WebM/MOV files) and saves them as a single local file.
```

**webRequest**

```
Observes the URLs and response headers (content type, size) of requests made by web pages to detect video playlists (.m3u8), segments (.ts) and video files (.mp4/.webm/.mov) while the user plays them. Requests are only read, never modified or blocked. Detected URLs stay in chrome.storage.session on the device and are never sent anywhere. YouTube pages and hosts are ignored.
```

**downloads**

```
Saves the video the user chose to the user's download folder: direct video files are downloaded with chrome.downloads, and the download id of merged HLS files is looked up so the popup can show the file in its folder.
```

**downloads.open**

```
Lets the user open a finished video from the "Completed" list in the popup (play button). Only called when the user clicks that button.
```

**storage**

```
chrome.storage.session keeps detected streams and download progress while the service worker restarts; chrome.storage.local keeps the last 10 completed downloads (title, file name, domain) and one display setting. All data stays on the device.
```

**offscreen**

```
An offscreen document (reason BLOBS) downloads the HLS segments, merges them into one MP4 Blob with the bundled mux.js and saves it. A service worker cannot hold Blobs or create object URLs for this.
```

**declarativeNetRequestWithHostAccess**

```
Some video hosts only serve the stream to requests that come from the page it is played on. While a download the user started is running, a session rule sets the Referer/Origin headers of the extension's own requests (no tab, only the hosts of that stream) to the page the video was played on. The rule is removed when the download ends. Page requests are never modified or blocked.
```

**호스트 권한 (<all_urls>)**

```
Videos can be played on any website and are often served from separate CDN hosts, so the extension needs to observe media requests on all sites and fetch the playlists/segments of the stream the user chose. No content scripts are injected and page content is not read. YouTube hosts are excluded in code.
```

**원격 코드**: **아니요, 원격 코드를 사용하지 않습니다** (hls.js 1.5.7, mux.js 6.0.1 공식 배포본을 패키지에 포함)

**데이터 사용**: 수집 항목 **모두 체크 안 함**(기기 밖으로 보내는 데이터 없음) + 서약 3개 체크

**개인정보처리방침 URL**

```
https://github.com/nermer1/m3u8DownLoadExtension/blob/main/PRIVACY.md
```

## 4. 배포

- **공개 범위**: 공개 (Public)
- **지역**: 모든 지역

## 5. 테스트 안내 (추가 안내 500자 제한, 인증 정보는 비워 둠)

```
No account needed (UI is Korean). Test with open-license streams:
1. Open https://hlsjs.video-dev.org/demo/ and play the default stream.
2. Click the MediaDown icon: the stream is listed once. Pick a resolution, press the blue download button; progress shows and an MP4 is saved.
3. On a Wikimedia Commons video page, play the video and download the detected WebM file the same way.
4. On youtube.com the popup shows "not supported"; nothing is detected.
```

## 6. 제출

탭마다 저장 → **검토를 위해 제출**. 반려되면 메일의 위반 코드명으로 이 문서와 코드 보완 후 재제출.

## 7. (선택) 데모 영상 순서 — 1분

1. hls.js 데모 페이지 재생 → 팝업에 한 줄로 감지 → 화질 선택 → 다운로드 → 진행바 → 완료 → 재생
2. Wikimedia Commons 영상 페이지 → WebM 감지 → 다운로드 → 완료
3. YouTube 페이지 → "이 사이트는 지원하지 않습니다"

상업 사이트·저작권 영상은 영상과 안내에 절대 넣지 않는다.
