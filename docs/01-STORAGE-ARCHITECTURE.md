# 코드레벨 분석 ② 저장 계층 해부

모든 경로는 레포 루트 기준. 라인 번호는 `97f9465` 기준.

---

## ① IMemoryStore — L0/L1 + 벡터 + FTS

### 인터페이스

`MemoryCore/src/core/store/types.ts:551`

```ts
export interface IMemoryStore extends MemoryPromptStore, MemoryGenerationRefStore {
  init(providerInfo?): MaybePromise<StoreInitResult>;
  isDegraded(): boolean;              // ← 동기
  getCapabilities(): StoreCapabilities; // ← 동기
  close(): void;                      // ← 동기
  isFtsAvailable(): boolean;          // ← 동기

  upsertL1(record, embedding?): MaybePromise<boolean>;
  searchL1Vector(q, topK?, text?, filter?): MaybePromise<L1SearchResult[]>;
  searchL1Fts(ftsQuery, limit?, filter?): MaybePromise<L1FtsResult[]>;
  searchL1Hybrid?(params): MaybePromise<L1SearchResult[]>;
  // ... L0 동일 세트, entity CRUD, audit, knowledge, prompt ...
}
```

**결정적 사실 1 — 인터페이스는 이미 async 를 허용한다.**

`types.ts:494`
```ts
export type MaybePromise<T> = T | Promise<T>;
```

그리고 **모든 호출부가 `await` 를 붙인다.** 예:

```
core/tools/memory-search.ts:233       await vectorStore.searchL1Vector(...)
core/hooks/auto-recall.ts:596         await vectorStore.searchL1Vector(...)
core/record/l1-dedup.ts:229           await vectorStore.searchL1Vector(...)
core/tools/conversation-search.ts:217 await vectorStore.searchL0Vector(...)
```

`TcvdbMemoryStore` (`core/store/tcvdb.ts`) 는 HTTP 기반이라 **전부 `async`** 다
(`tcvdb.ts:287 init`, `:650 upsertL1`, `:960 searchL1Vector`). 이게 살아있는 증거다:
**원격/비동기 백엔드는 이미 1급 시민이다.**

> 예외는 5개뿐: `isDegraded / getCapabilities / close / isFtsAvailable /
> supportsDeferredEmbedding`. 전부 캐시된 플래그를 반환하면 되는 것들이고,
> TCVDB 구현이 이미 그렇게 하고 있다.

### SQLite 구현

`MemoryCore/src/core/store/sqlite.ts` (3,835 LOC)

드라이버 획득 — `sqlite.ts:156-161`
```ts
const require = createRequire(import.meta.url);
function requireNodeSqlite() { return require("node:sqlite"); }
```

커넥션 오픈 — `sqlite.ts:452-470`
```ts
this.db = new DbSync(dbPath, { allowExtension: true });
this.db.exec("PRAGMA busy_timeout = 5000");
this.db.exec("PRAGMA journal_mode = WAL");
this.db.exec("PRAGMA cache_size = -65536");     //  64MB
this.db.exec("PRAGMA mmap_size = 134217728");   // 128MB
this.db.exec("PRAGMA wal_autocheckpoint = 1000");
```

`mmap_size` / `wal_autocheckpoint` 는 **로컬 파일 전용 pragma** 다. 원격 DB 에서는 무의미.

확장 로딩 — `sqlite.ts:510-527`
```ts
if (this.dimensions > 0) {
  const sqliteVec = require("sqlite-vec");
  this.db.enableLoadExtension(true);
  sqliteVec.load(this.db);
}
```

**`dimensions === 0` 이면 sqlite-vec 을 아예 로드하지 않는다.** 기본 설정
(`embedding.provider = "none"`) 이 바로 이 경로다 → 벡터 테이블 없이 FTS5 만으로 동작.
실패해도 `degraded = true` 로 떨어지고 전 메서드가 무해한 no-op 이 된다.

### 스키마

```sql
-- 관계형 (sqlite.ts:626, :748)
l1_records(record_id PK, content, type, priority, scene_name,
           session_key, session_id, team_id, task_id, user_id, agent_id,
           version, timestamp_*, created_time, updated_time, metadata_json)
l0_conversations(record_id PK, session_key, session_id, team_id, task_id,
                 user_id, agent_id, role, message_text, recorded_at, timestamp)

-- 벡터 (sqlite.ts:684, :806) — dimensions > 0 일 때만
CREATE VIRTUAL TABLE l1_vec USING vec0(
  record_id TEXT PRIMARY KEY,
  embedding float[N] distance_metric=cosine,
  updated_time TEXT DEFAULT ''
);
CREATE VIRTUAL TABLE l0_vec USING vec0(... recorded_at ...);

-- 전문검색 (sqlite.ts:1088, :1111)
CREATE VIRTUAL TABLE l1_fts USING fts5(content, content_original UNINDEXED, ... );
CREATE VIRTUAL TABLE l0_fts USING fts5(message_text, ... );

-- 그 외 같은 파일(vectors.db) 안에 동거하는 테이블
embedding_meta, entity_teams/users/agents/tasks/knowledge, memory_audit,
memory_prompts, memory_prompt_settings, memory_prompt_setting_logs,
memory_generation_refs, skills, skill_fts, skill_vec
```

**전부 하나의 `vectors.db` 파일 하나에 들어간다.** 온라인 마이그레이션은
`ALTER TABLE ADD COLUMN` 을 try/catch 로 감싸는 방식 (`sqlite.ts:650-656`).

### KNN 검색 경로 — 여기가 이식의 진짜 병목

준비된 statement — `sqlite.ts:734-739`
```sql
SELECT record_id, distance
FROM l1_vec
WHERE embedding MATCH ?
  AND k = ?
ORDER BY distance
```

`searchL1Vector()` — `sqlite.ts:1470-1570`

```
1. l1_vec 에 KNN 1회       → record_id + distance 목록 (topK*5 개, 필터 있을 때)
2. for (각 후보) {
     this.stmtGetMeta.get(record_id)   ← ★ 후보 1건당 SQL 1회 (sqlite.ts:1513)
     rowMatchesIsolation(meta, filter) ← ★ 테넌시 필터링을 JS 에서 사후 수행
   }
3. topK 로 트림
```

두 가지가 문제다:

1. **N+1 쿼리.** 로컬 SQLite 에서는 마이크로초라 무시할 수 있지만, 네트워크 왕복이
   붙는 순간 `topK=5, filter 有` → 25번의 개별 왕복이 된다. 원격 DB 에 이 코드를
   그대로 얹으면 회수당 수백 ms 가 그냥 날아간다.
2. **사후 필터링.** `vec0` 는 메타데이터 pre-filter 를 못 하므로 5배 over-fetch 후
   JS 에서 team/user/agent 를 거른다. 즉 격리 정확도가 over-fetch 배수에 의존한다.

원격 백엔드로 갈 거면 이 루프는 **SQL JOIN 한 방**으로 다시 써야 한다. 다행히
그건 `IMemoryStore` 계약 안에서 자유롭게 가능하다 — 인터페이스는 결과 배열만 본다.

### 탈출구(escape hatch) — `getRawDb()`

`sqlite.ts:481`
```ts
getRawDb(): DatabaseSync { return this.db; }
```

소비자는 **딱 한 곳**이다 — `core/tdai-core.ts:861-880`:

```ts
const rawDbCarrier = this.vectorStore as unknown as { getRawDb?: () => unknown };
if (typeof rawDbCarrier.getRawDb !== "function") {
  this.logger.warn(`Skill wiring skipped: vectorStore does not expose getRawDb() ...`);
  return;                                    // ← 우아하게 포기한다
}
const db = rawDbCarrier.getRawDb() as import("node:sqlite").DatabaseSync;
const skillStore = new SqliteSkillStore({ db, dimensions, logger });
```

즉 **`getRawDb()` 가 없는 스토어는 Skill 모듈만 꺼지고 나머지는 정상 동작한다.**
그리고 TCVDB 경로용으로 `core/store/tcvdb-skill-store.ts` (2,503→ 별도 32KB) 가 이미 있다.
`StorePool.getSkillStore()` (`store-pool.ts:304`) 가 그걸 붙인다.

### 백엔드 선택 지점 (하드코딩된 switch 3곳)

```
config.ts:183            export type StoreBackend = "sqlite" | "tcvdb";
config.ts:480            storeBackendRaw === "tcvdb" ? "tcvdb" : "sqlite"
core/store/factory.ts    createStoreBundle()  — switch (config.storeBackend)
core/store/store-pool.ts StorePool            — mode: "sqlite" | "tcvdb"
```

**플러그인 레지스트리가 아니다.** 새 백엔드를 넣으려면 이 4곳을 직접 고쳐야 한다.
반대로 말하면 **고칠 곳이 4곳뿐**이다.

---

## ② IMetadataStore — team / user / agent / task / asset / ACL

`MemoryCore/src/metadata/store/interface.ts`

```
SqliteMetadataStore   sqlite-adapter.ts   1,818 LOC   node:sqlite, 전부 동기
MongoMetadataStore    mongodb-adapter.ts  1,358 LOC   전부 async
```

여기도 `MaybePromise` 계약이고, 문서 주석이 명시한다:

> *"모든 메서드는 동기 또는 비동기일 수 있으며, 호출자는 일률적으로 await 한다."*
> *"복합 쓰기는 구현 내부에서 원자성을 보장해야 한다 (SQLite 직렬 트랜잭션 / MongoDB withTransaction)."*

### 이식 관점에서 이 어댑터가 제일 얌전하다

SQL 실행 지점이 **정확히 4개 헬퍼**로 수렴한다 — `sqlite-adapter.ts:408-435`

```ts
private tx<T>(fn: () => T): T {
  this.db.exec("BEGIN");
  try { const r = fn(); this.db.exec("COMMIT"); return r; }
  catch (e) { this.db.exec("ROLLBACK"); throw e; }
}
private get<T>(sql, ...p): T | null { return this.db.prepare(sql).get(...p) ?? null; }
private all<T>(sql, ...p): T[]      { return this.db.prepare(sql).all(...p); }
private run(sql, ...p): void        { this.db.prepare(sql).run(...p); }
```

`this.db.*` 직접 호출은 **exec 14회 + prepare 3회 + close 1회**가 전부다.
100개 public 메서드는 전부 위 4개 헬퍼만 쓴다.

스키마 특징 (`sqlite-adapter.ts:105-110, :124-` ):
- `PRAGMA foreign_keys = ON`
- **부분 유니크 인덱스** 사용: `CREATE UNIQUE INDEX ... WHERE user_type = 'system_admin'`
- PK 충돌 판정을 **에러 메시지 정규식**으로 한다 (`sqlite-adapter.ts:76`):
  `/UNIQUE constraint failed: meta_\w+\.(user_id|team_id|...)/`
  → **드라이버를 바꾸면 에러 문자열 포맷이 달라져 이 판정이 깨질 수 있다.** 실제 함정.

### 공짜로 딸려오는 무기: 백엔드 무관 계약 테스트

`metadata/store/metadata-store.contract.ts` (854 LOC)

```ts
export function runMetadataStoreContract(
  name: string,
  makeStore: () => Promise<IMetadataStore>,
  teardown: (store: IMetadataStore) => Promise<void>,
): void
```

> *"동일한 케이스를 SQLite / MongoDB 각각에 돌려 백엔드 간 동작 일치를 보장한다."*

새 백엔드를 만들면 `runMetadataStoreContract("libsql", ...)` 한 줄로 전량 검증된다.

⚠️ **단, 오픈소스 릴리스에서 테스트 파일이 전부 제거됐다.** `MemoryCore` 안에
`*.test.ts` 는 **0개**다 (`vitest.config.ts` 는 `src/**/*.test.ts` 를 include 하는데
매칭되는 파일이 없다). 계약 스위트 본체는 남아있고 호출부만 없다 → 하네스는
직접 써야 하지만 **어서션은 공짜로 얻는다.**

---

## ③ IStorageBackend — L2/L3 마크다운 + Skill 리소스

`MemoryCore/src/core/storage/types.ts`, `factory.ts`

```
LocalStorageBackend   local-backend.ts       fs 기반
CosStorageBackend     integrations/cos/...   동적 import, 없으면 명확한 에러
```

설계 주석이 관계를 못박아 둔다:

> `IMemoryStore` = DB 추상화 (L0/L1 구조화 데이터 → VDB/SQLite)
> `IStorageBackend` = 파일 추상화 (L2/L3 마크다운 → COS/로컬FS)
> **둘은 병렬이지 대체 관계가 아니다.**

인터페이스는 **처음부터 전부 async** 다. 로컬 FS 구현도 async 로 감싸 통일했다.
→ **여기는 이식 난이도 0.** S3/R2/MinIO 어댑터를 하나 쓰면 끝난다.

데이터 디렉터리 레이아웃 — `utils/pipeline-factory.ts:219`
```ts
const dirs = ["conversations", "records", "scene_blocks", ".metadata", ".backup"];
```
`storage` 어댑터가 주입되면 로컬 디렉터리 생성을 아예 건너뛴다.

---

## ④ IKnowledgeStore — MemoryKnowledge (별도 서비스)

`MemoryKnowledge/src/store/types.ts` — 주석이 의도를 명시한다:

> *"third-party 의존성 0 (drizzle 도, better-sqlite3 도 없음). 이게 추상화 심이다:
> `IKnowledgeStore` 는 SQLite 백엔드를 예컨대 MySQL 구현으로 갈아끼울 수 있게 한다."*

구현은 `sqlite-store.ts` (650 LOC) — **`drizzle-orm` + `better-sqlite3`**.
`src/db/client.ts`:
```ts
const raw = new Database(opts.path);
raw.pragma("journal_mode = WAL");
raw.pragma("busy_timeout = 5000");
const db = drizzle(raw, { schema });
```

테이블 5개: `knowledge_code_graph`, `knowledge_wiki`, 감사 테이블 2개, `llm_binding`.
부분 유니크 인덱스를 쓴다 (`WHERE deleted_at IS NULL`).
`ALTER TABLE ADD COLUMN` 은 `PRAGMA table_info` 로 선검사 후 실행.

### 하지만 wiki 인덱스는 얘기가 다르다

`MemoryKnowledge/src/engines/wiki/index-db.ts` (324 LOC)

- **wiki 1개당 SQLite 파일 1개** (`index.db`), 본문 `.md` 와 같은 디렉터리
- 테이블: `wiki_fts` (FTS5), `page_meta`, `graph_edge`, `source`
- 읽기는 **LRU 커넥션 풀 (기본 `POOL_MAX = 300`)**, 쓰기는 별도 커넥션 후
  `wal_checkpoint(TRUNCATE)` → `close()`
- 주석에 fd 제약까지 명시: *"WAL 은 커넥션당 fd 3개 → `POOL_MAX × 3 + 여유 ≤ ulimit -n`"*
- MiniSearch 20GB OOM 을 이걸로 해결했다고 적혀 있음

**파일시스템 시맨틱에 가장 깊게 결합된 부분이다.** 여기는 원격 DB 로 옮기는 게
가장 어렵고, 옮길 이유도 가장 약하다 (wiki 인덱스는 파생물이라 언제든 재빌드 가능).

---

## ⑤ 그 외

**MemoryProxy** — `better-sqlite3` 를 optional dependency 로 lazy require
(`src/storage/factory.ts:270-275`). ProxyStorage 백엔드 5종 중 하나일 뿐이고
(Redis / COS / SQLite / FS / Memory), 멀티노드에서는 COS 를 권장한다.
**메모리 데이터를 저장하지 않는다** — 전부 MemoryCore Gateway 로 위임.

**MemoryPanel** — **무상태**. 자체 DB 없음. Gateway API 호출만 한다.

---

## 요약 표 — 심별 결합도

| 심 | 인터페이스 async? | 원격 구현 선례 | 로컬 파일 결합 | 이식 난이도 |
|---|---|---|---|---|
| ① IMemoryStore | ✅ MaybePromise, 호출부 전부 await | ✅ TCVDB (HTTP) | pragma, sqlite-vec, N+1 | **중** |
| ② IMetadataStore | ✅ MaybePromise | ✅ MongoDB | 없음 (4개 헬퍼로 수렴) | **하** |
| ③ IStorageBackend | ✅ 전부 Promise | ✅ COS | 없음 | **최하** |
| ④ IKnowledgeStore | ✅ (drizzle) | ❌ | 본체는 약함 / wiki index.db 는 매우 강함 | **하 / 최상** |
