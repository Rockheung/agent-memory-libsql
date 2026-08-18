# TencentDB Agent Memory — 코드레벨 분석 ① 전체 구조

> 분석 대상: `TencentCloud/TencentDB-Agent-Memory` @ `97f9465` (2026-08-15)
> 목적: **"에이전트 메모리를 여러 머신에서 공유하려면 어디를 건드려야 하는가"** 를
> 저장 계층 코드에서 직접 판정한다.

---

## 1. 레포는 4개의 독립 서비스다

단일 앱이 아니다. pnpm 워크스페이스도 아니고, **각자 package.json 을 가진 4개 프로젝트**가
한 레포에 들어있다.

| 컴포넌트 | 패키지명 | 역할 | 기본 포트 |
|---|---|---|---|
| **MemoryCore** | `@tencentdb-agent-memory/memory-tencentdb-v2` | 4계층 메모리 엔진 + Gateway HTTP + OpenClaw/Hermes 플러그인 | 8420 |
| **MemoryKnowledge** | `@tencentdb-agent-memory/knowledge-service` | LLM-Wiki / Code-Graph 인덱싱 서비스 | 8424 |
| **MemoryPanel** | `team-memory-control` | 웹 관리 콘솔 (**무상태**, 자체 DB 없음) | 8125 |
| **MemoryProxy** | `context-proxy` | 투명 LLM 프록시 — 코딩 에이전트를 무개조로 붙이는 경로 | 8096 |

MemoryCore `src/` 만 약 **87,000 LOC / 272 파일**이다. 저장 계층이 전체의 핵심 덩어리다.

```
MemoryCore/src/
  core/       37,584 LOC   ← 메모리 엔진 + store 구현체
  gateway/    14,313 LOC   ← HTTP /v2 /v3 API
  offload/    10,438 LOC   ← 툴 출력 오프로딩
  metadata/    9,989 LOC   ← team/user/agent/task 정규화 메타 저장소
  utils/       6,354 LOC
  ...
```

---

## 2. 4계층 메모리 모델

| 계층 | 내용 | 물리 저장 위치 |
|---|---|---|
| **L0** | 원문 대화 메시지 | SQLite `l0_conversations` + `l0_vec` + `l0_fts` |
| **L1** | 구조화된 원자 기억 | SQLite `l1_records` + `l1_vec` + `l1_fts` |
| **L2** | 시나리오 블록 (Markdown) | **파일 스토리지** (`scene_blocks/*.md`) |
| **L3** | 페르소나 (Markdown) | **파일 스토리지** |
| Skill | 재사용 가능한 기술 스냅샷 | SQLite `skills` + `skill_fts` + `skill_vec` |

**L2/L3 는 DB 가 아니라 파일이다.** `MemoryCore/src/core/storage/` 의 `IStorageBackend`
(로컬 FS 또는 Tencent COS) 가 담당한다. → 중앙화하려면 DB 하나만으로는 부족하고
**오브젝트 스토리지도 같이 공유**해야 한다. 이건 나중에 반복해서 걸리는 포인트다.

---

## 3. 이 레포에 실제로 존재하는 "저장 계층" 은 4개다

한 덩어리가 아니라 **서로 다른 4개의 심(seam)** 이다. Turso 이식 가능성 판정도
이 4개를 각각 따로 해야 한다.

```
① IMemoryStore        MemoryCore/src/core/store/types.ts:551
   ├─ VectorStore     sqlite.ts       (node:sqlite + sqlite-vec + FTS5)   3,835 LOC
   └─ TcvdbMemoryStore tcvdb.ts       (Tencent Cloud VectorDB, HTTP)      2,503 LOC

② IMetadataStore      MemoryCore/src/metadata/store/interface.ts
   ├─ SqliteMetadataStore  sqlite-adapter.ts   (node:sqlite)              1,818 LOC
   └─ MongoMetadataStore   mongodb-adapter.ts                             1,358 LOC

③ IStorageBackend     MemoryCore/src/core/storage/types.ts
   ├─ LocalStorageBackend (fs)
   └─ CosStorageBackend   (Tencent COS, 동적 import)

④ IKnowledgeStore     MemoryKnowledge/src/store/types.ts
   └─ SqliteKnowledgeStore (better-sqlite3 + drizzle-orm)
      + wiki 당 별도 index.db (better-sqlite3, LRU 풀 300 커넥션)
```

**핵심 관찰: ①②③ 전부 이미 "로컬 백엔드 + 원격 백엔드" 2구현을 갖고 있다.**
즉 추상화 심은 이미 실전 검증된 상태다. 벤더 락인된 단일 SQLite 구현이 아니다.

---

## 4. 기술 스택 요점

- **Node.js ≥ 22.16** 강제 (`MemoryCore/package.json`). 이유: `node:sqlite` 내장 모듈.
- MemoryCore 는 `better-sqlite3` 를 **쓰지 않는다.** Node 내장 `node:sqlite` 의
  `DatabaseSync` 를 쓴다. (`createRequire` 로 런타임 require — `sqlite.ts:159`)
- `sqlite-vec@0.1.7-alpha.2` 를 npm 의존성으로 고정.
- **better-sqlite3 를 쓰는 건 MemoryKnowledge 와 MemoryProxy 뿐이다.**
- `libsql` / `Turso` 는 레포 전체에 **단 한 번도 등장하지 않는다.**
- 임베딩은 외부 API (`@ai-sdk/openai` 호환). `provider: "none"` 이 기본값 →
  **기본 설정에서는 벡터 검색이 꺼져 있고 BM25/FTS5 만 돈다.**

---

## 5. 배포 형태

`deploy/global-images/` 에 멀티아치(amd64 + arm64) 도커 이미지 기동 스크립트가 있다.

```
agentmemory/memory-core:latest    :8420   ← named volume /data/tdai-memory
agentmemory/memory-hub:latest     :8424 + :8125
agentmemory/memory-proxy:latest   :8096
```

ARM64 이미지가 공식 제공된다 → **oci-ko / Pi 같은 ARM 박스에 그대로 올라간다.**

---

## 다음 문서

- [01-STORAGE-ARCHITECTURE.md](01-STORAGE-ARCHITECTURE.md) — 저장 계층 4개 심의 코드레벨 해부
- [02-TURSO-FEASIBILITY.md](02-TURSO-FEASIBILITY.md) — Turso/libSQL 이식 가능성 판정
- [03-CENTRALIZATION.md](03-CENTRALIZATION.md) — 실제 멀티머신 중앙화 설계안
