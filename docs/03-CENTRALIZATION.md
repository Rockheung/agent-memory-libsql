# 코드레벨 분석 ④ 멀티머신 중앙화 설계안

원하는 그림:

```
        중앙 기억 저장소
              │
    ┌─────────┼─────────┬─────────┐
   Mac      GPU-1     GPU-2      Pi
  Claude    Codex      ...       ...
```

코드를 읽은 뒤의 결론: **이 그림은 이미 이 레포에 구현되어 있다. 다만 중앙에 있는 게
DB 가 아니라 Gateway 다.**

---

## 1. 권장안 — Gateway 중앙화 (코드 수정 0)

```
                      한 대 (홈랩 / oci-ko / dgx)
        ┌────────────────────────────────────────────────┐
        │  memory-core  :8420                            │
        │    ├─ vectors.db      (SQLite + FTS5 [+vec])   │
        │    ├─ metadata.db     (SQLite)                 │
        │    ├─ scene_blocks/   (L2/L3 마크다운)          │
        │    └─ L1 추출 / L2 요약 / 임베딩 호출 전부 여기    │
        │  memory-hub   :8424 + :8125  (Knowledge/Panel) │
        │  memory-proxy :8096          (선택)             │
        └────────────────────────────────────────────────┘
                 ▲            ▲            ▲
        HTTP /v3 │            │            │
        ┌────────┴───┐  ┌─────┴────┐  ┌────┴────┐
        │ Mac        │  │ GPU-1    │  │ Pi      │
        │ mode:remote│  │mode:remote│  │  ...    │
        └────────────┘  └──────────┘  └─────────┘
```

각 머신의 OpenClaw 플러그인 설정:

```json
{
  "mode": "remote",
  "server": {
    "url": "https://memory.h.rockheung.xyz",
    "apiKey": "...",
    "instanceId": "default",
    "teamId": "rock", "agentId": "rock-agent", "userId": "rock"
  },
  "recall": { "maxResults": 5, "includePersona": true }
}
```

근거:
- `MemoryCore/index.ts:64` — `client|gateway|remote` → 씬 클라이언트로 위임
- `MemoryCore/openclaw-plugin/index.ts` — `MemoryClient` HTTP SDK 만 사용, 데이터 로직 0
- `MemoryCore/src/gateway/v2-router.ts:413-432` — 데이터 평면 18개 엔드포인트
  (`/v3/conversation/*`, `/v3/atomic/*`, `/v3/scenario/*`, `/v3/core/*`)
- `deploy/global-images/` — **멀티아치(amd64 + arm64) 공식 도커 이미지**

### 이 안이 좋은 이유 (코드에서 나온 근거)

1. **머신마다 임베딩/LLM 호출을 중복하지 않는다.** L1 추출 · L2 요약 · 임베딩은
   전부 게이트웨이 프로세스 안에서 돈다. Pi 에서 굳이 임베딩을 돌릴 이유가 없다.
2. **L2/L3 가 자동으로 같이 공유된다.** 이건 DB 가 아니라 파일이라
   (`core/storage/`, `scene_blocks/*.md`), DB 만 중앙화하는 방식으로는 **절대 안 풀린다.**
3. **N+1 KNN 문제가 안 생긴다** (`sqlite.ts:1513`). SQLite 파일이 게이트웨이 로컬이므로
   그 루프가 원래 설계된 조건 그대로 돈다.
4. **테넌시가 이미 있다.** `team_id / user_id / agent_id / task_id` 4차원 격리가
   L0/L1 전 테이블과 인덱스에 박혀 있다 (`sqlite.ts:626,748`).

> ⚠️ **`agentId` 를 머신별로 나누지 말 것.** L2/L3 페르소나의 정체성은
> `(teamId, agentId)` 쌍이다 (`core/profile/profile-sync.ts:20` —
> userId/sessionId/taskId 를 의도적으로 무시한다). 머신마다 `agentId` 를 다르게 주면
> **페르소나가 머신 수만큼 쪼개진다.** L0/L1 은 sessionId 로 알아서 갈리므로
> "어느 머신에서 나온 대화인가"는 그쪽으로 추적하면 된다.
> 상세: [04-MARKDOWN-PLACEMENT.md](04-MARKDOWN-PLACEMENT.md) §4

### 주의점

- `embedding.provider` 기본값이 `"none"` 이다 (`config.ts` 파서). **그대로 두면
  벡터 검색이 꺼지고 BM25/FTS5 만 돈다.** 벡터를 원하면 provider/baseUrl/apiKey/
  model/dimensions 를 전부 채워야 한다. `dimensions` 를 나중에 바꾸면 벡터 테이블을
  드롭하고 전량 재임베딩한다 (`sqlite.ts:initSchema` needsReindex 경로).
- `MEMORY_CORE_GATEWAY_API_KEY` 를 비워두는 게 기동 스크립트 기본값이다
  (`deploy/global-images/start-memory-core.sh:24-33`). **LAN 밖에 노출할 거면
  NPM 앞단에서 반드시 인증을 걸어야 한다.**
- 백업 = `tdai-memory-core-data` named volume 스냅샷. 이게 Turso 가 대신 해주길
  원했던 바로 그 노동이고, 이 안에서는 남는다.

---

## 2. 대안 — MemoryProxy 로 붙이기 (플러그인 없이)

`MemoryProxy` 는 OpenAI `/v1/chat/completions` 와 Anthropic `/v1/messages` 를
**프로토콜 무변경으로** 포워딩하면서 세션 초기화 · 컨텍스트 주입 · 대화 write-back 을
끼워넣는다.

```
Claude Code / Codex ──► memory-proxy :8096 ──► 상위 LLM
                              │
                              └─► memory-core :8420  (L0~L3, Skill, Meta)
```

즉 **클라이언트에 플러그인을 안 깔아도** 기억이 붙는다. `baseUrl` 만 바꾸면 된다.

이미 굴리고 있는 CLIProxyAPI 와 역할이 겹치므로, 체인으로 물릴지
(agent → memory-proxy → cliproxy → upstream) 는 별도 검토가 필요하다.
MemoryProxy 는 기억 데이터를 저장하지 않는다 — 전부 Gateway 로 위임한다.

---

## 3. Turso 를 굳이 넣는다면 — 어디에

Gateway 중앙화를 하고 나서도 "DB 운영을 없애고 싶다"면, 넣을 자리는 **게이트웨이 뒤**다.

```
Mac / GPU-1 / GPU-2 / Pi
        │  HTTP /v3
        ▼
   memory-core Gateway            ← 여전히 필요 (파이프라인/L2·L3 파일)
        │
        ├─ IMemoryStore    → LibsqlMemoryStore   (신규 2~3k LOC)
        ├─ IMetadataStore  → LibsqlMetadataStore (신규, 계약 테스트 有)
        └─ IStorageBackend → S3/R2 어댑터         (신규, 인터페이스 이미 async)
```

**Turso 를 넣어도 Gateway 는 사라지지 않는다.** 파이프라인과 L2/L3 파일이 있기 때문.
그래서 Turso 의 실익은 "볼륨 스냅샷 cron 을 안 짜도 된다" 정도로 줄어든다.

투자 대비:

| 작업 | 규모 | 얻는 것 |
|---|---|---|
| Gateway 중앙화 | 설정만 | 멀티머신 공유 전부 |
| S3/R2 스토리지 어댑터 | 200~400 LOC | L2/L3 백업 자동화 |
| LibsqlMetadataStore | 1,800 LOC 대응 | 메타 백업 자동화 |
| LibsqlMemoryStore | 2,000~3,000 LOC | L0/L1 백업 자동화 + KNN 품질 개선 |

**순서를 지키면 각 단계가 독립적으로 가치가 있고, 어디서 멈춰도 시스템이 돈다.**

---

## 4. 안 되는 조합 (미리 못 박아둘 것)

- ❌ **각 머신에서 로컬 플러그인(`mode: local`)으로 돌리면서 `vectors.db` 만 공유**
  (NFS / SMB / syncthing). SQLite WAL + `busy_timeout=5000` 는 네트워크 파일시스템에서
  깨진다. 게다가 `sqlite.ts:452` 가 `mmap_size=128MB` 를 켠다. 데이터 손상 경로다.
- ❌ **DB 만 Turso 로 옮기고 L2/L3 를 각 머신 로컬 파일로 두기.**
  페르소나/시나리오가 머신마다 갈라진다. 이 시스템의 핵심 가치가 L2/L3 에 있다.
- ❌ **Cloudflare D1.** sqlite-vec 미지원 → 벡터를 Vectorize 로 분리해야 하고,
  그러면 `IMemoryStore` 한 구현이 서비스 2개를 조율해야 한다.

---

## 5. 바로 해볼 수 있는 검증 (30분)

```bash
cd deploy/global-images
cp .env.example .env
# MEMORY_LLM_* / PROXY_UPSTREAM_* 채우기 (embedding 은 나중에)
./start-all.sh
curl http://localhost:8420/v3/meta/auth/verify
```

그다음 Mac 의 OpenClaw 설정에 `mode: "remote"` + `server.url` 을 넣고,
`/v3/conversation/add` → `/v3/atomic/search` 가 Pi 에서도 같은 결과를 주는지 본다.

**이게 되면 Turso 논의의 절반은 필요 없어진다.**
안 되는 부분(백업 자동화)만 남고, 그건 위 3장 순서대로 붙이면 된다.
