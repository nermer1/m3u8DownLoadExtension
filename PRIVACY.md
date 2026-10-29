# MediaDown 개인정보처리방침 / Privacy Policy

최종 수정일 / Last updated: 2026-10-29

## 한국어

MediaDown(이하 "확장 프로그램")은 사용자의 개인정보를 수집하거나 외부로 전송하지 않습니다.

**확장 프로그램이 다루는 정보와 용도**

| 정보 | 용도 | 보관 위치 |
|---|---|---|
| 웹페이지가 요청하는 영상 주소(.m3u8, .ts, .mp4 등)와 응답 헤더(형식·크기) | 재생 중인 영상을 감지해 팝업 목록에 표시 | 브라우저 세션 저장소(chrome.storage.session), 브라우저를 닫으면 삭제 |
| 현재 탭의 제목과 주소 | 저장 파일 이름 기본값, 지원하지 않는 사이트(YouTube) 안내 | 저장하지 않음 |
| 완료한 다운로드 목록(제목, 파일 이름, 사이트 도메인, 최근 10개) | 팝업의 "완료" 목록, 폴더 열기·재생 버튼 | 브라우저 로컬 저장소(chrome.storage.local), 팝업에서 언제든 삭제 가능 |
| 설정("모든 주소" 표시 여부) | 팝업 표시 방식 | 브라우저 로컬 저장소 |

- 위 정보는 사용자의 브라우저 안에서만 사용되며, 개발자나 제3자의 서버로 보내지 않습니다.
- 확장 프로그램이 네트워크로 보내는 요청은 사용자가 보고 있는 사이트의 영상 재생목록과 영상 파일을 받기 위한 요청뿐입니다.
- 분석 도구, 광고, 추적 코드를 사용하지 않습니다. 외부 코드를 불러와 실행하지 않습니다.
- YouTube 영상과 DRM으로 보호된 영상은 감지하거나 다운로드하지 않습니다.

## English

MediaDown ("the extension") does not collect personal data and does not send any data to the developer or third parties.

**Data the extension handles and why**

| Data | Purpose | Where it stays |
|---|---|---|
| Video URLs requested by web pages (.m3u8, .ts, .mp4, ...) and their response headers (type, size) | Detect the video being played and list it in the popup | Browser session storage (chrome.storage.session), cleared when the browser closes |
| Title and URL of the current tab | Default file name; notice on unsupported sites (YouTube) | Not stored |
| Completed downloads (title, file name, site domain, last 10) | "Completed" list, open-folder and play buttons | Browser local storage (chrome.storage.local), removable from the popup at any time |
| Setting ("show all URLs") | Popup display mode | Browser local storage |

- This data is used only inside the user's browser and is never transmitted to the developer or any third party.
- The only network requests the extension makes are to fetch the playlists and video files of the site the user is viewing.
- No analytics, ads, or tracking. No remotely hosted code.
- YouTube videos and DRM-protected videos are not detected or downloaded.

문의 / Contact: https://github.com/nermer1/m3u8DownLoadExtension/issues
