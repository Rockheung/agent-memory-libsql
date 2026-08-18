# ⑦ M0 검증 결과 — Gateway 중앙화 (Mac 로컬)

실행일 2026-08-19 / 환경: macOS, colima 4CPU 8GB aarch64, docker 29.2.1
이미지 `agentmemory/memory-core:latest` (**linux/arm64**, 1.36GB)

**판정: C0–C5 통과. 코드 수정 0줄로 멀티클라이언트 기억 공유가 동작한다.**
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
| C6 | L2/L3 파일 생성 | ⏳ 대화량 부족 (아래 F5) |
| C7 | 머신 간 L2/L3 병합 | ⏳ C6 선행 |

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

### F5 — L2/L3 는 대화량 임계치가 있다

기본값 `pipeline.everyNConversations: 5`, `l2DelayAfterL1Seconds: 90`,
`l2MinIntervalSeconds: 900`, `persona.triggerEveryN: 50`.
6개 메시지로는 L2 시나리오 블록도, L3 페르소나도 안 만들어진다. C6/C7 은 실사용 축적이 필요하다.

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

### F7 — reasoning effort 를 넘길 방법이 없다 ★

`StandaloneLLMOverrideConfig`(`config.ts:202-229`) 필드는
`enabled / baseUrl / apiKey / model / maxTokens / timeoutMs / provider / proxy` 가 전부다.
`adapters/standalone/llm-runner.ts:321` 의 `generateText()` 호출에도
`providerOptions` 가 없다 → **`reasoning_effort` 가 요청에 실리지 않는다.**

CLIProxyAPI 자체는 `reasoning_effort` / `reasoning.effort` 를 넣어도 200 을 준다(무시 여부는 불명).
모델 목록에도 `gpt-5.6-luna` 의 effort 변형은 없다
(`gemini-3.1-pro-low` / `gemini-3.6-flash-high` 처럼 접미사로 노출되는 모델군과 대조적).

선택지:
1. CLIProxyAPI 쪽 config 에서 모델별 기본 effort 지정 (포크 수정 0)
2. 포크에 `reasoningEffort` 필드 + `providerOptions: { openai: { reasoningEffort } }` 추가 (~10줄)
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
