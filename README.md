# MediaDown - HLS/MP4 Video Downloader (크롬 확장)

웹페이지에서 재생되는 HLS(.m3u8)·TS 스트림과 MP4·WebM·MOV 영상을 감지해, 화질을 골라 한 파일로 저장한다.

## 기능

- **자동 감지**: 영상을 재생하면 팝업에 목록이 뜬다 (아이콘 배지에 개수)
  - 같은 영상은 한 줄로 묶음: 마스터 재생목록과 화질별 재생목록, 토큰만 다른 주소, 내용이 같은 재생목록 (`streams.js`)
  - [모든 주소] 체크 시 감지된 주소를 묶지 않고 전부 표시
- **HLS/TS**: 조각을 받아 합친 뒤 MP4로 변환해 저장 (오프스크린 문서, mux.js). AES-128 암호화 스트림 지원
  - 일반 MP4(색인이 앞에 있는 faststart 구조)로 재구성해 플레이어에서 이동이 빠르다 (`mp4faststart.js`). 실패하면 조각형 MP4 → 원본 TS 순으로 저장
- **MP4·WebM·MOV 파일**: 크롬 기본 다운로드로 저장 (크기 표시, 일시정지·재개·취소)
- 미리보기 재생, 파일 이름 수정, 직접 주소 입력, 완료 목록(폴더 열기·재생)
- 팝업을 닫거나 다른 탭에 다녀와도 진행 상태 유지 (서비스 워커 재시작 대비 `chrome.storage.session` 보관)

## 지원하지 않는 것

- **YouTube** (`youtube.com`, `googlevideo.com` 등): Chrome 웹스토어 정책. 감지·다운로드하지 않고 팝업에 안내
- **DRM 보호 영상** (SAMPLE-AES, Widevine·PlayReady·FairPlay): 재생목록에 있으면 중단
- HLS 다운로드 중에는 확장의 요청에 영상이 재생된 페이지의 Referer·Origin 을 붙인다 (다운로드별 세션 규칙, 끝나면 삭제). 그래도 Cloudflare 봇 검사 등으로 막는 사이트는 403 으로 실패할 수 있음

권리가 있는 영상만 저장하세요.

## 구성

| 파일 | 역할 |
|---|---|
| `background.js` | webRequest 로 영상 요청 감지, 재생목록 분석, 다운로드 관리 |
| `streams.js` | 같은 영상 묶기·파일 판별·YouTube 차단 규칙 (순수 함수, node 테스트 가능) |
| `offscreen.js` | HLS/TS 조각 다운로드·복호화·병합·저장 |
| `mp4faststart.js` | 조각형 MP4(mux.js 출력·fMP4 HLS)를 일반 MP4로 재구성 (순수 함수, node 테스트 가능) |
| `popup.html/js/css` | 감지 목록, 진행률, 완료 목록 |
| `hls.min.js` | hls.js 1.5.7 공식 배포본 (미리보기 재생) |
| `mux.min.js` | mux.js 6.0.1 공식 배포본 (TS → MP4 변환) |
| `fonts/` | Outfit 폰트 (외부 요청 없이 확장에 포함) |
| `licenses/` | 포함한 라이브러리·폰트 라이선스 |

## 라이선스 고지

- hls.js — Apache License 2.0, Copyright (c) 2017 Dailymotion (`licenses/hls.js-LICENSE.txt`)
- mux.js — Apache License 2.0, Brightcove (`licenses/mux.js-LICENSE.txt`)
- Outfit font — SIL Open Font License 1.1, The Outfit Project Authors (`licenses/Outfit-OFL.txt`)

## 개인정보

수집·전송하는 데이터 없음. 자세한 내용은 [PRIVACY.md](PRIVACY.md).

## 웹스토어 패키지

태그(동결된 버전)에서 zip 을 만든다. `.gitattributes` 의 `export-ignore` 로 README·PRIVACY·`store/` 는 빠진다.

```bash
mkdir -p dist
git archive --format=zip -o dist/mediadown-1.4.zip v1.4
```

- 태그 `v<버전>` 은 `manifest.json` 의 `version` 과 같아야 한다
- 제출 문구·권한 사유·테스트 안내: `store/listing.md`, 이미지: `store/assets/*.png`
