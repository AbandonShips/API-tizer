# API-Tizer 동기화 백엔드 (Cloudflare Workers + D1)

이 폴더는 **영지식(Zero-Knowledge) 동기화 서버**입니다. 서버는 복호화 불가능한
암호문(AES-GCM)과 동기화에 필요한 최소한의 메타데이터만 저장합니다. 데이터를 푸는
키(Key A)는 절대 서버로 전송되지 않으므로, 서버가 통째로 유출돼도 내용은 읽을 수 없습니다.

## 사전 준비

- [Cloudflare 계정](https://dash.cloudflare.com/sign-up) (무료 플랜으로 충분)
- Node.js 설치 후 Wrangler CLI:
  ```bash
  npm install -g wrangler
  wrangler login
  ```

## 배포 순서

1. **D1 데이터베이스 생성**
   ```bash
   cd worker
   wrangler d1 create api-tizer-sync
   ```
   출력에 표시되는 `database_id` 를 복사해 `wrangler.toml` 의
   `database_id = "PASTE_YOUR_DATABASE_ID_HERE"` 에 붙여넣습니다.

2. **스키마 적용**
   ```bash
   wrangler d1 execute api-tizer-sync --remote --file=./schema.sql
   ```
   > 이미 운영 중인 DB를 v1.2로 올리는 경우에는 온라인 비밀번호 변경을 위해
   > `auth_changed_at` 컬럼을 한 번만 추가해야 합니다.
   > ```bash
   > wrangler d1 execute api-tizer-sync --remote --file=./migrations/0001_add_auth_changed_at.sql
   > ```
   > 새 DB에 `schema.sql`을 처음 적용하는 경우에는 별도 마이그레이션이 필요 없습니다.

3. **세션 토큰 서명용 비밀키 등록** (길고 무작위한 문자열)
   ```bash
   wrangler secret put AUTH_SECRET
   # 예시 값 생성: openssl rand -base64 48
   ```

4. **(권장) CORS 출처 제한** — `wrangler.toml` 의 `ALLOW_ORIGIN` 을 실제 앱 주소로 바꿉니다.
   ```toml
   [vars]
   ALLOW_ORIGIN = "https://abandonships.github.io,http://localhost:8753,http://127.0.0.1:8753"
   ```

5. **배포**
   ```bash
   wrangler deploy
   ```
   출력되는 주소(`https://api-tizer-sync.YOURNAME.workers.dev`)가 동기화 서버 URL입니다.

## 앱에 연결

배포된 Worker URL 을 앱에서 한 번만 등록하면 됩니다. 두 가지 방법 중 택1:

- **코드에 고정**: `src/sync.js` 의 `DEFAULT_ENDPOINT` 값에 URL 을 넣습니다. 현재 기본값은 `https://api-tizer-sync.kangmin1152.workers.dev` 입니다.
- **기기별 설정**: 브라우저 콘솔에서
  ```js
   localStorage.setItem('apitizer.sync.endpoint', 'https://api-tizer-sync.kangmin1152.workers.dev')
  ```

또한 `index.html` 의 CSP `connect-src` 에 Worker 도메인이 포함돼야 합니다.
기본값으로 `https://*.workers.dev` 가 허용되어 있으니, **커스텀 도메인**을 쓰는 경우에만
해당 도메인을 추가하세요.

## 로컬 테스트

```bash
wrangler dev --remote
```

## 엔드포인트 요약

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/api/auth/params` | 로그인 전 KDF 파라미터(salt, iterations) 조회 |
| POST | `/api/auth/signup` | 계정 생성 (Key B 의 해시만 저장) |
| POST | `/api/auth/login` | Key B 로 인증 → 세션 토큰 발급 |
| POST | `/api/auth/change` | (인증 필요) 비밀번호 변경 — Key A/Key B 재발급, 서버 데이터 초기화, 이전 토큰 무효화 |
| GET | `/api/sync/pull?since=<ms>` | 마지막 동기화 이후 변경분만 내려받기 |
| POST | `/api/sync/push` | 로컬 변경분 업로드 (서버 시간 기준 last-write-wins) |

## 보안 메모

- 서버는 `auth_token`(Key B)을 **PBKDF2 해시**로만 저장합니다. DB 가 유출돼도 비밀번호·Key A 를 알 수 없습니다.
- 충돌 해결은 "서버에 마지막으로 도달한 쓰기가 승리(서버 시계 기준)" 방식입니다. 개인용 다중 기기 사용에 적합합니다.
- 삭제는 tombstone(삭제 표시)으로 전파된 뒤 클라이언트에서 정리됩니다.
- 비밀번호를 바꾸면 `auth_changed_at` 이 갱신되어 **그 전에 발급된 모든 토큰이 401로 거부**됩니다. 다른 기기는 다음 동기화 시도 시 강제 로그아웃되며, 아직 올리지 않은 변경분은 소실될 수 있습니다(설계상 허용).
