# ⑦ M0 검증 결과 — Gateway 중앙화 (Mac 로컬)

실행일 2026-08-19 / 환경: macOS, colima 4CPU 8GB aarch64, docker 29.2.1
이미지 `agentmemory/memory-core:latest` (**linux/arm64**, 1.36GB)

**판정: C0–C7 전부 통과. 코드 수정 0줄로 멀티클라이언트 기억 공유가 동작한다.**
→ `02-TURSO-FEASIBILITY.md` §4 의 "Turso 없이 된다"가 실측으로 확인됐다.

---

## 구성

```
memory-core :8420  (colima 컨테이너, volume tdai-memory-core-data)
   ├─ LLM       gpt-5.6-luna  via CLIProxyAPI  http://10.77.0.4:8317/v1
   └─ Embedding bge-m3 (1024d) via ollama      http://192.168.88.223:11434/v1
```

- 컨테이너 → 오버레이망(`10.77.0.4`) **도달 확인**. colima NAT 가 호스트 라우팅을 탄다.
- 컨테이너 → dgx ollama(`192.168.88.223:11434`) **도달 확인**.
- `storeBackend: sqlite`, `deployMode: standalone`

---

## 체크리스트 결과

| | 항목 | 결과 |
|---|---|---|
| C0 | 이미지 pull / 기동 | ✅ healthy 9s |
| C1 | `/v3/meta/auth/verify` + admin 초기화 | ✅ (단 스크립트 버그 — 아래 F1) |
| C2 | `/v3/conversation/add` → `query` → `search` 왕복 | ✅ |
| C3 | 클라이언트 접속 (HTTP 직접) | ✅ |
| C4 | **다른 세션이 앞선 세션의 기억을 보는가** | ✅ 4/4 hit |
| C5 | 벡터 검색 | ✅ `strategy=hybrid`, vec0 후보 반환 |
| C6 | L2/L3 파일 생성 | ✅ |
| C7 | **세션 간 L2/L3 병합** | ✅ 3개 세션 → 프로필 1개 |

### C2/C4 실측

```
POST /v3/conversation/add   session=m0-mac-001   → accepted 2
POST /v3/conversation/add   session=m0-pi-002    → accepted 2
POST /v3/conversation/search "Turso 대신 무엇으로 결정했나"  (session 필터 없음)
  → hits=4  — mac 세션과 pi 세션 내용이 모두 반환됨
```

### C5 실측 — 의미 검색

질의 `"벡터 유사도로 뜻이 비슷한 문장을 찾는 방식"` (문자 일치 거의 없음)

```
0.0325  1024 차원 다국어 임베딩이라 형태소 분석 없이도 의미 검색이 됩니다...   ← 1위
0.0323  임베딩을 bge-m3 로 켰다...
0.0161  홈랩 중앙화는 Turso 대신 memory-core Gateway 한 대로...
```

로그: `[L0-search] queryEmbeddingDims=1024 → vec0 returned 2 candidate(s)`,
`RESULT (strategy=hybrid)`

### L1 추출

`gpt-5.6-luna` 로 실제 동작. 임베딩 켜기 전에는 `extracted=0` 이었고, 켠 뒤 정상 추출:

```
type=episodic  "사용자는 2026년 8월 18일에 한국어 검색 성능이 향상되는지 확인하기 위해 bge-m3 임베딩을 활성화했다."
type=episodic  "사용자(이름 미상)는 홈랩 중앙화를 Turso 대신 memory-core Gateway 한 대로 하기로 결정했다..."
```

---

## 발견 (F)

### F1 — `start-memory-core.sh` 가 macOS bash 3.2 에서 죽는다 ⚠️

```
[ok] memory-core 已启动 → http://localhost:8420/
./start-memory-core.sh: line 175: ADMIN_KEY_FILE<0xef>: unbound variable
```

`start-memory-core.sh:175`:
```bash
info "初始化 admin user（username=${MEMORY_CORE_ADMIN_USERNAME}, key 持久化 → $ADMIN_KEY_FILE）..."
                                                                  #  중괄호 없는 변수 ─┘  ┗─ 전각 괄호(멀티바이트)
```

bash 3.2(macOS 기본, `3.2.57`)는 `$ADMIN_KEY_FILE` 뒤에 붙은 전각 `）`의 UTF-8 바이트를
변수명 일부로 파싱한다 → `set -u` 와 만나 fatal. **게이트웨이 자체는 이미 healthy 라
컨테이너는 정상이고, admin 유저 초기화만 안 된다.**

→ 우회: `/v3/internal/meta/user/init-admin` 을 직접 호출.
→ **upstream 에 이미 PR 있음: #966, #1050, #1052. 중복 제출 금지.** 실측으로 재현 확인된 셈.

### F2 — `MEMORY_LLM_*` 없이도 게이트웨이는 뜬다

L0 저장/조회/검색은 LLM 무관. LLM 은 L1/L2/L3 에만 필요하다.
→ M0 를 LLM 없이 먼저 돌려보는 것도 가능하다.

### F3 — 데이터 평면 인증은 "아무 Bearer 나" 통과 (standalone)

`v2-router.ts:353` `parseV2Auth` 는 **비어있지 않은 Bearer 토큰 + `x-tdai-service-id`** 만 본다.
`MEMORY_CORE_GATEWAY_API_KEY` 가 빈 값이면 `Bearer local` 로 전부 통과한다.
반면 `/v3/meta/*` 는 `x-tdai-user-key` 로 실제 검증한다.

⚠️ **LAN 밖으로 낼 거면 `MEMORY_CORE_GATEWAY_API_KEY` 를 반드시 설정하거나 앞단에서 막아야 한다.**

### F4 — 임베딩을 나중에 켜면 기존 데이터는 벡터가 없다

임베딩 활성화 후 `vec0 returned 2 candidate(s)` — **켠 뒤에 쓴 2건만** 벡터가 있다.
앞서 넣은 4건은 FTS 로만 잡힌다. 자동 reindex 는 돌지 않았다.

→ **운영 원칙: 데이터 넣기 전에 임베딩을 먼저 켠다.** `dimensions` 를 바꾸면
벡터 테이블을 드롭하고 전량 재임베딩한다(`sqlite.ts` needsReindex 경로) — 차원 변경은 비싸다.

### F5 — L2/L3 는 루트가 아니라 **프로필 스코프 디렉터리**에 쌓인다 ★

처음에 `/data/tdai-memory/scene_blocks/` 와 `persona.md` 를 보고 "안 만들어졌다"고 판단했는데
**틀렸다.** 실제 산출물은 스코프 하위에 있다:

```
/data/tdai-memory/profiles/team%3Ateam-9muccx5zxu%7Cagent%3Aagt-9mudpy0pqv/
  ├─ scene_blocks/홈랩-중앙화-메모리코어-Gateway.md     ← L2
  ├─ .metadata/scene_index.json
  └─ persona.md                                        ← L3
```

**디렉터리 이름이 곧 프로필 스코프다** — `team:<teamId>|agent:<agentId>` 를 URL 인코딩한 것.
**session 이 들어있지 않다.** 파이프라인 로그도 같은 말을 한다:

```
[L2] session=profile:team:T|agent:A|session:m0-gpu-003, profile=team:T|agent:A
                └─ 스케줄러 태스크 키 (세션 포함)      └─ 프로필 정체성 (세션 없음)
```

→ `04-MARKDOWN-PLACEMENT.md` §4 의 **"L2/L3 정체성은 (teamId, agentId)"** 주장이
파일시스템 레벨에서 확인됐다. `buildProfileL2Key`(`pipeline-factory.ts:100-103`)가
세션을 붙이는 건 태스크 키뿐이다.

### C7 실측 — 세션 3개가 프로필 1개로 병합

`m0-mac-001` / `m0-pi-002` / `m0-gpu-003` 세 세션이 **하나의 scene block** 으로 합쳐졌다:

```
summary: 홈랩 중앙화를 memory-core Gateway 한 대로 통합하고, 마크다운 기반 페르소나
         구조를 유지하면서 bge-m3 임베딩을 활성화해 한국어 검색 성능 개선을 검증하려 한다.
heat: 2
```

앞 문장은 mac 세션, 뒷 문장은 gpu 세션에서 왔다. L3 persona.md 도 생성됐다.

→ **머신을 늘려도 `agentId` 만 같으면 인격이 하나로 축적된다.** 이것이 M0 의 핵심 확인 사항이었다.

### F6 — 한국어에서 벡터 검색은 선택이 아니라 필수다 ★

FTS5 토크나이저 로그:

```
[hybrid-fts] FTS5 query: ""Turso" OR "대" OR "신" OR "무" OR "엇" OR "으" OR "로" OR "결" OR "정" OR "했" OR "나""
→ scores: [0.690, 0.000, 0.000, 0.000]
```

`bm25.language: "zh"` + `@node-rs/jieba` 는 **중국어** 분절기다. 한국어는 형태소가 아니라
**음절 단위로 쪼개진다.** 사실상 "Turso" 같은 라틴 토큰만 매칭되고 나머지는 노이즈다.

→ 이 프로젝트는 중국어/영어 사용자를 기준으로 만들어졌다.
→ **한국어로 쓸 거면 `embedding.provider` 를 반드시 켜야 한다.** BM25 단독은 못 쓴다.
→ `bge-m3` 는 다국어 임베딩이라 이 문제에 정확히 맞는 선택이다.

### F7 — reasoning effort: MemoryCore 는 못 보내지만 **CLIProxyAPI 서버에서 지정 가능** ★

`StandaloneLLMOverrideConfig`(`config.ts:202-229`) 필드는
`enabled / baseUrl / apiKey / model / maxTokens / timeoutMs / provider / proxy` 가 전부다.
`adapters/standalone/llm-runner.ts:321` 의 `generateText()` 호출에도
`providerOptions` 가 없다 → **`reasoning_effort` 가 요청에 실리지 않는다.**

CLIProxyAPI 자체는 `reasoning_effort` / `reasoning.effort` 를 넣어도 200 을 준다(무시 여부는 불명).
모델 목록에도 `gpt-5.6-luna` 의 effort 변형은 없다
(`gemini-3.1-pro-low` / `gemini-3.6-flash-high` 처럼 접미사로 노출되는 모델군과 대조적).

**oci-ko 서버 실측 (2026-08-19): 서버 측 지정이 가능하다.**

`config.example.yaml:471-483` 에 정확히 이 용례가 문서화돼 있고,
`config.yaml` 에 **이미 사용 중**이다:

```yaml
payload:
  override:                       # override = 값이 있어도 항상 덮어씀
    - models:
        - name: "gpt-5.6-sol"
          protocol: "codex"
      params:
        "reasoning.effort": "low"
```

- **유효 레벨 = `low, medium, high, xhigh, max`** (업스트림 400 에러가 목록을 뱉음).
  즉 **최댓값은 `high` 가 아니라 `max`** 다.
- `auth-dir` 에 `codex-<account>` 가 있으므로 `gpt-*` 계열은 `protocol: "codex"` 가 맞다.
- **설정 핫리로드된다.** journalctl 에 PID 변경 없이
  `server clients and configuration updated` 가 찍힌다 → 재시작 불필요.
- 클라이언트가 보낸 `reasoning_effort` 는 업스트림까지 **전달된다**
  (잘못된 값이 업스트림 400 을 받음). 못 보내는 건 순전히 MemoryCore 쪽 한계다.

⚠️ **`override` 는 해당 모델의 모든 소비자에게 적용된다** (LibreChat 등 포함).
스코프를 좁히려면 `default:`(값이 없을 때만 적용) 또는 규칙의 `headers:` / `match:` 조건을 쓴다.

### F7-해결 — `oauth-model-alias` + `payload.override` 조합으로 해결 ✅

**effort 조합을 별도 모델로 노출할 수 있다.** `oauth-model-alias` 문서:

> *"You can repeat the same name with different aliases to expose multiple client model names."*
> `fork: true` — 원본 업스트림 모델을 유지한 채 별칭을 **별도 모델로 추가** 노출

적용한 설정 (oci-ko `/home/ubuntu/cliproxy/config.yaml`, 2026-08-19):

```yaml
oauth-model-alias:
  codex:
    - { name: "gpt-5.6-sol",  alias: "gpt-5.6-sol-low", fork: true }
    - { name: "gpt-5.6-luna", alias: "gpt-5.6-luna-max",  fork: true }

payload:
  override:
    - { models: [{name: "gpt-5.6-sol", protocol: "codex"}],       params: {"reasoning.effort": "low"} }   # 기존(Leo/BYOM용) 유지
    - { models: [{name: "gpt-5.6-sol-low", protocol: "codex"}], params: {"reasoning.effort": "low"} }   # 신규
    - { models: [{name: "gpt-5.6-luna-max", protocol: "codex"}],  params: {"reasoning.effort": "max"} }   # 신규
```

**핵심 미지수였던 "규칙이 별칭을 보는가 업스트림 이름을 보는가" → 별칭을 본다.** 실측:

| 모델 | 규칙 | reasoning_tokens |
|---|---|---|
| `gpt-5.6-luna` | 없음 (프로바이더 기본) | **1,519** |
| `gpt-5.6-luna-max` | `reasoning.effort: max` | **3,624** (2.4배) |

동일 프롬프트(정육면체 세제곱합 조합 문제), `max_tokens=2000`.
`gpt-5.6-sol-low` 는 단순 질문에 `reasoning_tokens=0` — low 가 걸린 것과 일관.

부수 확인:
- **설정 핫리로드.** journalctl 에 PID 변경 없이 `configuration updated` → 재시작 불필요
- 모델 목록 47 → 49개. 원본 `gpt-5.6-sol` / `gpt-5.6-luna` **동작 변화 없음** (fork)
- 응답의 `model` 필드는 업스트림 이름(`gpt-5.6-luna`)으로 온다.
  별칭으로 돌려받으려면 별칭 항목에 `force-mapping: true` 를 추가한다 (현재 미적용)
- 백업: `config.yaml.bak.20260818-194357`

**별칭 이름 규칙**: 접미사는 **effort 유효값과 일치**시킨다 (`low` / `medium` / `high` /
`xhigh` / `max`). 초기에 `sol-light` 로 붙였다가 `sol-low` 로 정정했다 — 조합을 계속
늘릴 것이므로 이름만 봐도 effort 가 읽혀야 한다.

⚠️ **`sed -i` 로 config 를 고치면 핫리로드가 안 걸린다.** rename 이 inode 를 바꿔
파일 워처가 감시를 잃는다. `systemctl restart cliproxy.service` 가 필요하다
(1초, LibreChat 잠깐 끊김). 파이썬 in-place 재작성은 inode 를 유지하지만,
워처가 이미 끊긴 뒤에는 소용없다.

**→ 포크 수정 0줄로 해결됐다.** `MEMORY_LLM_MODEL=gpt-5.6-luna-max` 로 바꾸는 것이 전부이고,
LibreChat 등 다른 소비자는 원본 모델을 그대로 쓴다. 스코프 문제도 같이 사라졌다.

### F11 — L1 추출 모델 A/B: **`sol-low` 채택**

동일 대화(사실 4개 포함)를 각 모델에 먹여 L1 추출을 비교했다.

| 모델 | 지연 | 추출 | 원자화 |
|---|---|---|---|
| **`gpt-5.6-sol-low`** | **7.5초** | 1건 | 4개 사실을 한 덩어리로 |
| `gpt-5.6-luna-max` | 23.6초 | 1건 | 한 덩어리 |
| `claude-sonnet-4-6` | 608초 ⚠️ | 2건 | 스냅샷 일정을 별도 기억으로 분리 |

**채택: `gpt-5.6-sol-low`.** L1 추출은 매 턴 도는 작업이고, 추출 내용이 실질적으로
동일한데 luna-max 대비 3배 빠르다. max effort 가 값을 하는 건 어려운 추론인데
**L1 추출은 추론이 아니라 발췌**다.

단서:
- Sonnet 608초는 액면 그대로 믿지 말 것. `generateText` 자체 측정치라 cliproxy
  재시도나 구독 쿨다운일 가능성이 크다. 어느 쪽이든 이 환경에선 쓸 수 없다.
- 원자화 차이(Sonnet 2건)는 **n=1 이라 강한 근거가 아니다.** 다만 L1 은 각 레코드가
  독립적으로 벡터 회수되므로, 뭉치면 검색 정확도가 무뎌지는 건 구조적으로 맞다.
  실사용에서 회상 품질이 아쉬우면 여기를 먼저 의심할 것.

### F12 — 계층별 모델 분리가 설정에는 있는데 동작하지 않는다 ★

```
cfg.extraction.model   → L1 추출        (config.ts:551, pipeline-factory.ts:607)
cfg.persona.model      → L2/L3          (pipeline-factory.ts:799,895,1015,1070)
```

값은 런너까지 전달되지만 **standalone 런너가 무시한다** (`adapters/standalone/llm-runner.ts`):

```ts
this.model = opts.model ?? opts.config.model;   // :260  생성 시 고정
model: provider.chat(this.model)                // :322  params.model 을 안 읽는다
```

`params.model` 을 읽는 코드가 아예 없다. OpenClaw 런너는 `modelRef` 로 받는데
게이트웨이 경로는 **전 계층 단일 모델**이다.

→ "L1 은 싼 모델, L2/L3 는 좋은 모델" 조합이 현재 불가능하다.
→ **포크 패치 후보.** `llm-runner.ts` 몇 줄이고 F7 의 effort passthrough 와 같은 자리다.
   upstream PR 후보로도 유효 (#228 `feat(llm)` 선례와 같은 카테고리).

### F10 — max effort 는 L1 추출 지연을 3배 이상 늘린다

동일한 2메시지 L1 추출:

```
기본 effort   run() completed:  ~7,000ms
max  effort   run() completed:  23,660ms   (extracted=1, stored=1)
```

L1/L2 는 백그라운드 파이프라인이라 사용자 체감 지연은 아니지만,
`l1IdleTimeoutSeconds: 600` 같은 타이머와 토큰 비용에는 직접 영향이 있다.
회상(recall) 경로는 LLM 을 안 타므로 영향 없음.

---

### 남은 선택지 (참고)

1. ~~CLIProxyAPI `payload.override`~~ ← **채택·적용 완료**
2. 포크에 `reasoningEffort` 필드 + `providerOptions: { openai: { reasoningEffort } }` (~10줄)
   → 더 이상 필요 없지만, upstream PR 후보로는 여전히 유효 (#228 선례)
3. effort 접미사가 붙은 다른 모델 사용

> 2번은 **upstream PR 후보로 유망하다.** 병합 실적이 있는 카테고리와 정확히 같다 —
> upstream #228 `feat(llm): support multi-provider disableThinking strategies` (+514, merged).
> 다만 `llm-runner.ts` 는 `FORK.md` 의 수정 허용 6곳 밖이므로,
> `pr/llm-reasoning-effort` 브랜치를 `feat/server_team` 에서 따로 떠서 진행한다.

### F8 — 로컬 GB10 모델은 현재 못 쓴다

CLIProxyAPI 경유 기준:
- `qwen3.5-122b-gb10` → 45s 타임아웃
- `deepseek-v4-gb10` → 500, 백엔드 `192.168.88.223:8001` 연결 실패 (포트 닫힘)
- ollama(`:11434`)는 정상 → **임베딩은 로컬로, LLM 은 원격으로** 가 현재 최적 조합

### F9 — 로컬 환경 이슈 (upstream 무관)

`~/.docker/config.json:3` 에 `"credsStore": "osxkeychain"` 이 남아있는데
`docker-credential-osxkeychain` 바이너리가 없다(Docker Desktop 제거 흔적).
→ `DOCKER_CONFIG` 환경변수로 우회 중. 영구 수정은
`brew install docker-credential-helper` 또는 해당 줄 제거.

---

## M1 범위에 미치는 영향

| 원래 가정 | M0 실측 후 |
|---|---|
| Turso 로 L0/L1 중앙화 필요 | **불필요.** Gateway 한 대로 공유가 확인됨 |
| 남는 문제는 백업 자동화 | 그대로 유효 (볼륨 스냅샷 1개) |
| 벡터 검색은 선택 사항 | **한국어에서는 필수** (F6) |
| — | **effort 전달 경로 부재** 라는 새 항목 (F7) |

→ **M2/M3(libSQL 백엔드)의 긴급도는 내려간다.**
→ 대신 **F7(effort passthrough)** 이 실사용에 바로 걸리는 항목으로 올라온다.

## 다음

- [ ] C6/C7 — 실사용 대화를 쌓아 L2/L3 생성 및 병합 확인
- [ ] F7 — effort 경로 결정 (CLIProxyAPI 설정 vs 포크 패치 vs 모델 교체)
- [ ] `MEMORY_CORE_GATEWAY_API_KEY` 설정 후 oci-ko 이관 (arm64 확인됨)
- [ ] 볼륨 스냅샷 백업 잡
