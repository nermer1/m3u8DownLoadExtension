# Chrome 웹스토어 제출 자료 — MediaDown

개발자 대시보드에서 탭별로 그대로 복사해 넣는다.
업로드 zip: `dist/mediadown-<버전>.zip` (README "웹스토어 패키지"). 이미지: `store/assets/*.png`.
이미지 다시 만들기: `node store/assets/build-demo.js` → `popup-demo.html?scene=list|downloading|youtube` 를 headless 크롬으로 450x720(배율 2) 캡처 → `screenshot-*.html` 1280x800 캡처.

---

## 1. 패키지

- 새 항목 → `dist/mediadown-1.2.zip` 업로드

## 2. 스토어 등록정보

**설명**

```
웹페이지에서 재생되는 영상을 감지해 한 파일로 저장하는 다운로더입니다.

■ 지원 형식
- HLS 스트림(.m3u8) / TS 조각: 조각을 받아 MP4 한 파일로 합쳐 저장
- MP4 · WebM · MOV 영상 파일: 크롬 기본 다운로드로 저장

■ 기능
- 자동 감지: 영상을 재생하면 팝업에 목록이 표시됩니다
- 같은 영상은 한 줄로: 화질별 재생목록·토큰만 다른 주소를 하나로 묶어 보여줍니다
- 화질 선택: 여러 화질을 제공하는 스트림은 원하는 화질을 골라 받을 수 있습니다
- 진행률·속도·남은 시간 표시, 일시정지·재개·취소
- 팝업을 닫아도 다운로드는 계속되고, 다시 열면 진행 상태가 그대로 보입니다
- 미리보기 재생, 파일 이름 수정, 주소 직접 입력
- 완료 목록에서 폴더 열기·바로 재생

■ 지원하지 않는 것
- YouTube 영상 (Chrome 웹스토어 정책)
- DRM으로 보호된 영상
- 일부 사이트는 자체 보호 설정으로 다운로드가 거부될 수 있습니다

■ 개인정보
- 어떤 데이터도 수집하거나 외부로 보내지 않습니다. 분석·광고·추적 코드가 없습니다.
- 감지한 주소와 완료 목록은 브라우저 안에만 저장됩니다.

※ 저작권이 있는 영상은 권리자의 허락 없이 저장·배포할 수 없습니다. 권리가 있는 영상만 저장하세요.
```

- **카테고리**: 도구 (Tools) — 목록에 없으면 가장 가까운 "생산성"
- **언어**: 한국어
- **스토어 아이콘 128×128**: `icons/icon128.png`
- **캡처 화면 (1280×800)**: `store/assets/screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png`
- **작은 프로모션 타일 (440×280)**: `store/assets/promo-small.png`
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
