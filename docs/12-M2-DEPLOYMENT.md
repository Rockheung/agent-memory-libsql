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

### 7. core 도 host 네트워크여야 한다 ★

edge/proxy 만 host 로 바꿨더니 **L1 추출이 조용히 0건**이 됐다.
core 가 L1/L2/L3 추출을 위해 cliproxy 를 **직접** 부르기 때문이다.

```
[standalone-runner] run() failed: Cannot connect to API: connect EHOSTUNREACH 10.77.0.4:8317
[l1] L1 complete: extracted=0, stored=0
```

**채팅 응답은 정상 200 이라 겉으로는 멀쩡해 보인다.** 로그를 안 보면 못 잡는다.
core 도 `network_mode: host` 로 바꾸고, 대신 `TDAI_GATEWAY_HOST=127.0.0.1` 로
루프백에만 바인딩해 외부 노출을 막았다.

### 8. core config 도 렌더링이 필요하다

`tdai-gateway.yaml` 의 LLM `apiKey` 가 `REPLACE_ME` 인 채로 배포돼
추출이 `Unauthorized` 로 실패했다. proxy 와 같은 방식으로 `core-config`
렌더링 서비스를 두고 `.env` 값을 주입한다. 이것도 **채팅은 정상**이라 안 보인다.

> 두 건 모두 "응답은 200 인데 기억이 안 쌓인다" 형태다. **배포 검증은 응답이 아니라
> 저장소를 봐야 한다.** 이 문서 전체를 관통하는 교훈이다.

---

## 최종 검증

```
채팅 http=200
응답: 기억하겠습니다. - 상시 호스트: oci-ko - 상태 저장소: Turso + Oracle Object Storage

L1 complete: extracted=1, stored=1   (LLM 7.1초)

Turso: l0 6 | l0vec 6 | l1 1 | l1vec 1 | l1fts 1
L1 [episodic]: "사용자는 2026년 8월 24일에 oci-ko를 메모리 게이트웨이의 상시 호스트로
                정하고, 상태 데이터를 Turso와 Oracle Object Storage에 저장하기로 결정했다."
```

**L0 → 벡터 → L1 추출 → 벡터 + FTS 까지 전 파이프라인이 관리형 인프라 위에서 동작한다.**

---

# 상시화 마무리 (2026-08-25)

## systemd

```
/etc/systemd/system/memory-stack.service   enabled + active
```
`restart: unless-stopped` 만으로는 **한 번도 `up` 하지 않은 상태**(새 볼륨, config
렌더링 컨테이너)가 복구되지 않는다. 유닛이 부팅마다 `docker compose up -d` 를 돌려
렌더링까지 다시 태운다.

## 방화벽 — 공인망은 계속 닫는다

oci-ko 는 공인 IP 가 있고 컨테이너는 `0.0.0.0` 에 바인딩된다. cliproxy(8317)가
쓰던 것과 **동일한 정책**으로 홈랩 LAN + 오버레이망만 연다.

```
iptables -I INPUT 1 -p tcp -s 192.168.88.0/24 --dport 8090 -j ACCEPT   # edge
iptables -I INPUT 1 -p tcp -s 10.77.0.0/24    --dport 8090 -j ACCEPT
iptables -I INPUT 1 -p tcp -s 192.168.88.0/24 --dport 8420 -j ACCEPT   # core
iptables -I INPUT 1 -p tcp -s 10.77.0.0/24    --dport 8420 -j ACCEPT
netfilter-persistent save
```

공인망 차단은 OCI 보안목록이 이미 하고 있다 (`nc seoul.oracle...:8090` 불가 확인).
**이중 방어이며, 어느 한쪽만 믿지 않는다.**

## NPM 프록시 호스트

| 도메인 | 대상 | 용도 |
|---|---|---|
| `cliproxy-memd.h.rockheung.xyz` | `10.77.0.4:8090` (edge) | 기억이 붙는 OpenAI 호환 엔드포인트 |
| `memory.h.rockheung.xyz` | `10.77.0.4:8420` (core) | `/v3/*` 직접 호출 (훅 어댑터용) |

기존 `cliproxy.h` 를 본떠 만들었다 — 같은 LE 와일드카드(cert id=3), SSE 를 위해
`proxy_buffering off` + 600s 타임아웃.

```
https://cliproxy-memd.h.rockheung.xyz/v1/models   → 49개
https://memory.h.rockheung.xyz/health             → 200
```

## ClaudeCodeAdapter 전환

Mac 의 훅이 이제 oci-ko 를 본다.
```
endpoint: https://memory.h.rockheung.xyz
team/agent/user: team-dao10rbbqc / agt-dao2se7qb5 / usr-dao0wjxnsr
주입 2285자  (core/read 3.2s · atomic/search 0.6s · scenario/ls 0.07s)
```
기존 Mac colima 설정은 `~/.claude/memory-adapter.json.mac-backup` 에 보관.

⚠️ 첫 호출이 3.2초로 느리다 — TLS 핸드셰이크 + 오버레이 왕복 + 커널 콜드스타트가
겹친 값이다. 훅 예산이 15초라 여유는 있지만, 상시 체감이 나쁘면
`recall_timeout_seconds` 를 조정하거나 L3 주입을 세션당 1회로 유지하는 현재 설계에
의존하게 된다.

## 클라이언트 접속 방법

```
BrowserOS / LibreChat / 임의 OpenAI 호환:
  base URL:  https://cliproxy-memd.h.rockheung.xyz/v1
  api key :  admin user_key (oci-ko:~/memory-fork/MemoryStack/.admin-key)
  모델    :  기존 49개 그대로. 기억은 자동으로 붙는다.

기억 없이 쓰려면:
  base URL:  https://cliproxy.h.rockheung.xyz/v1     (기존 그대로)
```
