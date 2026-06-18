# 목양실 10:12

교회 레크레이션으로 시작했다가 관리자의 신호로 크라임씬 조사 화면으로 전환되는 모바일 웹 앱입니다.

## 핵심 기능

- 관리자 페이지: 힌트 코드 해제, 정답 확인, 참가자 화면 모드 전환
- 참가자 페이지: 밝은 레크레이션 대기 화면에서 시작, 신호 수신 후 크라임씬 UI로 전환
- 힌트 시스템: 4명 × 3개 = 총 12개 힌트, 힌트코드 입력으로만 해제
- 25대 동시 전환 설계: 참가자 화면이 공유 상태 API를 0.85~1.35초 랜덤 간격으로 폴링
- 배포 지원: Vercel 정적 페이지 + `/api/mode` 서버리스 API

## 로컬 실행

```bash
python3 server.py
```

접속:

- 관리자: <http://localhost:8123/index.html>
- 참가자: <http://localhost:8123/player.html>
- 미리보기: <http://localhost:8123/preview.html>

휴대폰 테스트는 같은 와이파이에서 맥의 IP를 사용합니다.

```bash
ifconfig en0
```

예: `http://192.168.x.x:8123/player.html`

## Vercel 배포

Preview 배포:

```bash
npx vercel@latest --yes
```

운영 배포:

```bash
npx vercel@latest --prod
```

## 25대 동시 전환을 위한 필수 저장소

Vercel 서버리스 함수의 메모리는 인스턴스마다 분리될 수 있습니다. 25대 휴대폰을 안정적으로 동시에 전환하려면 Upstash Redis 또는 Vercel KV를 연결하고 아래 환경 변수를 설정하세요.

```env
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

설정이 없으면 `/api/mode`는 메모리 모드로 동작합니다. 이 모드는 로컬/짧은 preview 확인에는 충분하지만, 행사 당일 다중 기기 동기화용으로는 권장하지 않습니다.

## 운영 흐름

1. 참가자들은 `player.html`에 접속해 밝은 레크레이션 화면을 봅니다.
2. 관리자는 `index.html`에서 `크라임씬으로 전환`을 누릅니다.
3. `/api/mode` 상태가 `crime`으로 바뀝니다.
4. 참가자 휴대폰은 각자 폴링 주기에 따라 1초 안팎으로 크라임씬 화면으로 전환됩니다.
5. 참가자는 현장에서 얻은 힌트코드를 입력해 12개 힌트를 해제합니다.
6. 모든 힌트를 열면 최종 추리 봉투가 열립니다.

## 주요 파일

```text
.
├── index.html          # 관리자 페이지
├── player.html         # 참가자 모바일 페이지
├── preview.html        # 관리자/참가자 분할 미리보기
├── server.py           # 로컬 실행 서버 + 모드 API
├── api/mode.js         # Vercel 서버리스 모드 API
├── assets/             # 배경, 증거, 인물 이미지
├── docs/               # 앱 흐름도와 운영 문서
├── vercel.json         # Vercel 설정
└── .vercelignore       # 배포 제외 파일
```
