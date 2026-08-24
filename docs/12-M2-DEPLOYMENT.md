# ⑬ M2 — oci-ko 상시 배포

2026-08-25 / `oci-ko` (ARM64, 2 OCPU / 11GB)

**상태: 3개 컨테이너 healthy, 엣지 통과 채팅 왕복 확인, 대화가 Turso 에 적재됨.**

---

## 구성

```
클라이언트 → edge :8090 (host net) → proxy :8096 (host net) → cliproxy 10.77.0.4:8317
                                          ↓
                                     core :8420 (bridge, 127.0.0.1 만 노출)
                                          ├─► Turso        메타 · L0/L1 · 벡터 · Skill
                                          └─► Object Store L2/L3 md · JSONL · checkpoint
```

기동 로그로 확인한 백엔드 선택:
```
[META-V3] metadata store pool ready (backend=libsql)
[factory] Store created: backend=libsql, url=libsql://memd-rockheung...
StorageAdapter initialized (s3: https://cndsb3agfhez.compat.objectstorage...)
[skill][config] initialized: storeBackend=libsql, routing.mode=bm25
```

## 배포에서 걸린 것 6가지

문서에 없어 삽질하기 쉬운 순서대로.

### 1. Docker Hub 이미지에는 포크 코드가 없다 (당연하지만 놓치기 쉽다)

`agentmemory/memory-core:latest` 로 띄우면 로그가 전부 `backend=sqlite` 다.
**포크를 빌드해야 한다.** 전체 재빌드(네이티브 모듈 컴파일)는 2 OCPU 에서 비싸므로
**upstream 이미지를 베이스로 바뀐 소스만 얹는** Dockerfile 을 썼다 (`core/Dockerfile`).

### 2. upstream Dockerfile 이 `--omit=optional` 을 쓴다 ★

우리는 `@libsql/client` / `@aws-sdk/client-s3` 를 **optionalDependencies** 에 뒀다
(동적 import 백엔드는 선택 의존성이라는 upstream 관례). 그래서 기본 이미지에 없다.
포크 Dockerfile 이 명시적으로 설치한다.

### 3. cliproxy 가 WireGuard 인터페이스에만 바인딩돼 있다 ★

```
LISTEN 10.77.0.4:8317      ← wg0 전용. 도커 브리지에서 안 보인다
```
컨테이너에서 `Host is unreachable` 이 난다. **edge / proxy 를 `network_mode: host`**
로 붙여 해결했다. core 는 브리지에 남되 `127.0.0.1:8420` 으로 노출한다.

### 4. healthcheck 가 `/` 를 치면 안 된다

`GATEWAY_API_KEY` 를 켜면 `/` 는 401 이다. **인증 예외는 `/health` 뿐**
(`gateway/server.ts:1063`). 내가 `/` 로 써서 core 가 계속 unhealthy 였다.

### 5. `envsubst` 의 인자는 "변수 이름 목록" 이다 ★

```sh
envsubst '$VAR_A $VAR_B' < in > out    # 이름 목록 (맞음)
envsubst "$VAR_A $VAR_B" < in > out    # 값이 전개됨 → 빈 목록 → 0 바이트 출력
```
후자를 써서 proxy config 가 **0 바이트**로 렌더링됐고, 프록시는 조용히
템플릿 기본값(`llm-upstream.example.com`)으로 떴다. 렌더링 후 `test -s` 로 막았다.

### 6. MemoryProxy 가 커널 호출에 Bearer 를 안 보낸다 ★ (upstream 버그)

`verifyUserKey` 가 `Authorization` 헤더를 붙이지 않는다. 커널에
`TDAI_GATEWAY_API_KEY` 를 켜는 순간 **모든 인증이 401** 이 된다.
우회가 "게이트웨이 인증 끄기" 뿐이라 `MemoryProxy` 도 포크했다 — 3곳, 하위 호환.
`FORK.md` 의 "MemoryProxy 는 건드리지 않는다" 규약을 깬 유일한 사례이며 사유를 명시했다.

### 보너스: 세션 초기화 폼을 건너뛰려면 `x-task-id` 도 필요하다

team/agent 만 주면 폼이 뜬다. `headerAutoSelect` 는 셋을 다 본다.
`bootstrap.sh` 에 기본 task 생성 단계를 넣었다.

---

## 검증

```
$ curl -X POST http://127.0.0.1:8090/v1/chat/completions \
    -H "Authorization: Bearer $(cat .admin-key)" \
    -d '{"model":"gpt-5.6-sol-low","messages":[...]}'

  http=200
  응답: 홈랩 게이트웨이는 **oci-ko**에 있고, 상태는 **Turso와 오브젝트 스토리지**에 저장합니다.
```

적재 확인:
```
Turso: users 1 | tasks 1 | l0 2 | l0vec 2
L0: "홈랩 게이트웨이는 **oci-ko**에 있고..."
L0: "기억 테스트다. 내 홈랩 게이트웨이는 oci-ko 에..."
```

## 남은 것

- [ ] NPM 에 `memory.h.rockheung.xyz` / `cliproxy-memd.h.rockheung.xyz` 프록시 호스트 등록
- [ ] Mac 의 ClaudeCodeAdapter 를 oci-ko 게이트웨이로 전환 (현재 Mac colima 를 본다)
- [ ] L1 추출이 실제로 도는지 확인 (검증 시점엔 대기 중이었다)
- [ ] `docker compose` 를 systemd 로 올려 재부팅 생존
