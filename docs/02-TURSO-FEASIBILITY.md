# 코드레벨 분석 ③ Turso / libSQL 이식 가능성 판정

원래 질문:

> TencentDB Agent Memory 를 손 안 대고 Turso 에 꽂을 수 있는가?
> 아니면 작은 adapter 로 되는가? 구조적으로 안 맞는가?

**코드를 읽고 나온 판정: "connection string 만 바꾸는 식으로는 안 된다.
그런데 구조적으로 안 맞는 것도 아니다. 심(seam)별로 답이 다르다."**

---

## 0. 먼저 판정에 쓰인 3가지 사실

| # | 사실 | 근거 |
|---|---|---|
| A | `IMemoryStore` / `IMetadataStore` 는 **이미 async 를 허용**하고, 모든 호출부가 `await` 한다 | `core/store/types.ts:494,551`; `metadata/store/interface.ts`; 호출부 `auto-recall.ts:596` 등 |
| B | **원격 백엔드 선례가 이미 2개 있다** — TCVDB(HTTP), MongoDB | `core/store/tcvdb.ts`, `metadata/store/mongodb-adapter.ts` |
| C | 로컬 SQLite 결합은 **드라이버(`node:sqlite`) + sqlite-vec vec0 + 로컬 pragma + N+1 접근 패턴** 네 군데에 몰려 있다 | `core/store/sqlite.ts:159,452,510,734,1513` |

A·B 때문에 "구조적으로 안 맞음"은 아니고, C 때문에 "무수정 이식"도 아니다.

---

## 1. 심별 판정

| 심 | Turso 이식 판정 | 근거 |
|---|---|---|
| ③ `IStorageBackend` (L2/L3 파일) | **해당 없음.** Turso 가 아니라 S3/R2 가 필요 | 인터페이스가 이미 전부 async. 어댑터 하나 |
| ② `IMetadataStore` | **작은 어댑터로 가능** | SQL 실행이 `get/all/run/tx` 4개 헬퍼로 수렴. 계약 테스트 존재 |
| ④ `IKnowledgeStore` (본체) | **거의 무료** | `drizzle-orm` → `drizzle-orm/libsql` 로 드라이버 교체 |
| ④ wiki `index.db` | **구조적으로 안 맞음** | wiki 당 파일 1개 + LRU 300 커넥션 + `wal_checkpoint(TRUNCATE)` |
| ① `IMemoryStore` | **여기가 진짜 문제.** 아래 상세 | vec0 + N+1 + 동기 pragma |

---

## 2. ① IMemoryStore — 세 가지 경로

### 경로 A. `libsql` npm 패키지 + embedded replica (동기 API 유지)

`libsql` 은 better-sqlite3 호환 동기 API 를 제공하고 embedded replica 를 지원한다.
`VectorStore` 의 동기 구조를 그대로 살릴 수 있어 보이는 유일한 길이다.

**하지만 세 개의 실질 장벽이 있다.**

1. **드라이버 API 가 정확히 같지 않다.**
   현재 코드는 `node:sqlite` 의 `DatabaseSync` / `StatementSync` 를 쓴다
   (`sqlite.ts:27,159,452`). `libsql` 은 **better-sqlite3** 호환이다. 형태는
   비슷하지만(`prepare().get/all/run`, `exec`) 동일 API 는 아니다.
   다행히 실제 사용 표면은 좁다:
   ```
   sqlite.ts            db.exec ×124, db.prepare ×109, enableLoadExtension ×1, close ×1
   metadata 어댑터       db.exec ×14,  db.prepare ×3,  close ×1
   skill-store.ts       db.exec ×12,  db.prepare ×11
   ```
   → **`DatabaseSync` 시그니처를 흉내내는 얇은 shim 클래스 하나**면 덮인다.
   진짜 위험은 `run()` 반환 형태, `Buffer` 바인딩(임베딩을 `Buffer.from(f32.buffer)`
   로 넣는다 — `sqlite.ts:1492`), 그리고 **에러 메시지 문자열**이다.
   `metadata/store/sqlite-adapter.ts:76` 은 UNIQUE 위반을 **정규식으로** 판정한다:
   ```ts
   /UNIQUE constraint failed: meta_\w+\.(user_id|team_id|...)/
   ```
   드라이버가 바뀌면 이게 조용히 깨진다. **반드시 계약 테스트로 잡아야 하는 지점.**

2. **sqlite-vec 을 원격 primary 가 이해해야 한다. ← 결정적**
   embedded replica 는 읽기를 로컬에서 하고 **쓰기는 원격 primary 로 전달**한다.
   그런데 이 코드가 쓰는 문장은 이거다:
   ```sql
   INSERT INTO l1_vec (record_id, embedding, updated_time) VALUES (?, ?, ?)  -- sqlite.ts:722
   SELECT record_id, distance FROM l1_vec WHERE embedding MATCH ? AND k = ?  -- sqlite.ts:734
   ```
   `l1_vec` 은 `vec0` 가상 테이블이다. 즉 **Turso 서버 쪽에도 sqlite-vec 이 로드되어
   있어야** 쓰기가 성립한다. 로컬 replica 에만 확장을 로드하는 걸로는 안 된다.
   → Turso 가 해당 플랜/리전에서 sqlite-vec 을 실제로 제공하는지가 **선결 조건**이다.
   (사용자가 확인한 "Fly Cloud Provider 의 Pro/Enterprise 에서 optional extension" 이
   여전히 유효한지, 그리고 버전이 이 레포가 고정한 `0.1.7-alpha.2` 와 호환인지 —
   **이건 문서가 아니라 실제 DB 에 붙어서 검증해야 한다.**)

3. **`mmap_size` / `wal_autocheckpoint` 는 원격에서 의미가 없다** (`sqlite.ts:452-470`).
   치명적이진 않지만, "그대로 동작한다"는 착각을 만든다.

> 참고: `libsql` 패키지가 `loadExtension` 을 노출하는지는 **미확인**이다.
> 경로 A 를 진지하게 볼 거면 이걸 제일 먼저 확인해야 한다.

**평가: 확인해야 할 외부 조건이 너무 많고, 그 조건이 전부 참이어도 얻는 건
"로컬 파일이 여전히 각 머신에 있는" 구조다.** 아래 4장에서 다시 짚는다.

---

### 경로 B. `@libsql/client` (async) + libSQL 네이티브 벡터로 새 스토어 작성

인터페이스가 `MaybePromise` 이므로 **완전 비동기 구현이 계약상 합법**이다.
`TcvdbMemoryStore` 가 정확히 그 선례다.

바꿔야 하는 건 스키마와 검색 쿼리다:

```sql
-- 현재 (sqlite-vec)
CREATE VIRTUAL TABLE l1_vec USING vec0(
  record_id TEXT PRIMARY KEY,
  embedding float[1536] distance_metric=cosine,
  updated_time TEXT
);
SELECT record_id, distance FROM l1_vec WHERE embedding MATCH ? AND k = ?;

-- libSQL 네이티브 (확장 불필요)
ALTER TABLE l1_records ADD COLUMN embedding F32_BLOB(1536);
CREATE INDEX l1_emb_idx ON l1_records(libsql_vector_idx(embedding));
SELECT r.record_id, vector_distance_cos(r.embedding, vector32(?)) AS distance
FROM vector_top_k('l1_emb_idx', vector32(?), ?) AS v
JOIN l1_records r ON r.rowid = v.id
WHERE r.team_id = ? AND r.agent_id = ?          -- ★ 격리 필터를 SQL 로 내림
ORDER BY distance;
```

이 재작성이 **오히려 현재 구현보다 낫다**:

- 별도 벡터 테이블이 사라진다 → `upsert = delete + insert` 라는 vec0 우회
  (`sqlite.ts` 헤더 주석: *"vec0 virtual table does NOT support ON CONFLICT"*) 가 불필요
- **N+1 이 사라진다.** 현재는 후보 1건당 `stmtGetMeta.get()` 을 1회씩 친다
  (`sqlite.ts:1513`). 네트워크 왕복이 붙는 원격 DB 에서 이건 그냥 못 쓴다.
  JOIN 한 방으로 바뀐다.
- **격리(team/user/agent) 필터를 SQL 로 내릴 수 있다.** 현재는 5배 over-fetch 후
  JS 에서 `rowMatchesIsolation()` 으로 거른다 (`sqlite.ts:1483,1535`).
  즉 리콜 정확도가 over-fetch 배수에 의존하는 현재 약점이 사라진다.

FTS5 (`l1_fts` / `l0_fts` / `skill_fts`) 는 libSQL 이 SQLite 기반이라 그대로 간다.

**비용:** `sqlite.ts` 3,835 LOC 에 대응하는 새 구현체. `tcvdb.ts` 가 2,503 LOC 인 걸
보면 현실적 규모는 **2,000–3,000 LOC + 백엔드 스위치 4곳 수정**이다.

```
config.ts:183             type StoreBackend = "sqlite" | "tcvdb" | "libsql"
config.ts:480             파싱 분기
core/store/factory.ts     createStoreBundle() switch 에 case 추가
core/store/store-pool.ts  StoreMode 에 "libsql" 추가 + createLibsqlStore()
```

추가로 Skill 모듈: `getRawDb()` 가 없으면 `tdai-core.ts:867` 이 경고 후 스킵한다.
즉 **Skill 없이 먼저 굴리고 나중에 붙여도 된다.** TCVDB 도 별도
`tcvdb-skill-store.ts` 를 갖고 같은 패턴을 쓴다.

**평가: 이게 "제대로 하는" 길이다. 그리고 이건 더 이상 adapter 가 아니라 포크다.**

---

### 경로 C. ② + ④ 만 Turso 로, ① 은 그대로 두기

- `IMetadataStore` → libSQL 어댑터 (헬퍼 4개 + 100 메서드 async 화, 계약 테스트로 검증)
- `IKnowledgeStore` → `drizzle-orm/better-sqlite3` → `drizzle-orm/libsql`
- `IMemoryStore` → **로컬 SQLite 유지**

**평가: 노력 대비 효과가 가장 나쁘다.** 정작 공유하고 싶은 건 L0/L1 기억인데
그게 로컬에 남는다. 팀/에이전트 메타만 중앙화된다.

---

## 3. Cloudflare D1 은?

`sqlite-vec` 이 D1 지원 확장 목록에 없다 (FTS5 / JSON / math 정도).
벡터는 Vectorize 로 분리해야 한다 → `IMemoryStore` 를 **두 서비스로 쪼개는** 구현이 된다.
`TcvdbMemoryStore` 와 비슷한 규모의 작업인데 서비스가 2개다. **경로 B 보다 나쁘다.**

---

## 4. 그런데 — 애초에 DB 를 중앙화하는 게 맞나

코드를 읽다 보면 **이 프로젝트는 "DB 공유"가 아니라 "서비스 공유"로 설계돼 있다.**

`MemoryCore/openclaw.plugin.json`:
```json
"mode": { "enum": ["local", "function", "client", "gateway", "remote"], "default": "local" }
```
`MemoryCore/index.ts:59-71, 180-184`:
```ts
if (rawMode === "client" || rawMode === "gateway" || rawMode === "remote") return "client";
...
if (adapterMode === "client") return registerClientOpenClawPlugin(api);
```

그리고 `MemoryCore/openclaw-plugin/index.ts` 는 **데이터 로직이 0 인 순수 HTTP 클라이언트**다:

> *"본 플러그인은 어떤 데이터 처리 로직도 포함하지 않는다 (VDB/Embedding/Pipeline 없음).
> 모든 기억 연산은 원격 Gateway 에 위임한다."*

즉 **여러 머신이 기억을 공유하는 정식 경로는 이미 구현돼 있고, 그건 Turso 가 아니라
Gateway 다.** 저장 계층은 한 대(게이트웨이 호스트) 안에서만 로컬 SQLite 로 남는다.

이 관점에서 보면:

| 목표 | Turso 가 푸는 문제 | Gateway 가 푸는 문제 |
|---|---|---|
| 여러 머신이 같은 기억을 본다 | ✅ (단, ①의 재작성 필요) | ✅ (설정만) |
| DB 서버 운영/스냅샷/백업 노동 제거 | ✅ | ❌ (볼륨 백업 직접) |
| L2/L3 마크다운 공유 | ❌ (파일이라 별개) | ✅ (게이트웨이 로컬 FS 한 곳) |
| 임베딩/파이프라인 CPU 를 한 곳에 모음 | ❌ (각 머신이 각자 돌림) | ✅ |
| 지금 코드로 오늘 되는가 | ❌ | ✅ |

**Turso 는 "DB 운영 노동"만 가져간다. 그런데 이 시스템에서 진짜 노동은 DB 가 아니라
파이프라인(L1 추출 / L2 요약 / 임베딩 호출)이고, 그건 Gateway 가 가져간다.**

---

## 5. 최종 판정

```
질문: TencentDB Agent Memory 를 Turso 에 꽂을 수 있는가?

├─ SQL 만 쓰는가?                → 아니다. vec0 확장 + node:sqlite 드라이버 결합
├─ sqlite-vec SQL 을 쓰는가?      → 그렇다. MATCH + k = ? 구문 (sqlite.ts:734,844)
└─ 로컬 파일 API 에 의존하는가?    → 부분적. pragma 는 있으나 fs 직접 접근은 없음

→ 판정: **"작은 adapter" 아님. "새 백엔드 구현" 맞음. 단, 인터페이스는 이미
   그걸 받아들이도록 설계돼 있다.**

우선순위 (수정):
  1. Gateway 중앙화               ← 코드 수정 0. 오늘 된다.
  2. (원한다면) MemoryKnowledge 만 Turso   ← drizzle 드라이버 교체
  3. (그래도 원한다면) LibsqlMemoryStore   ← 2,000–3,000 LOC 포크
  4. Turso + sqlite-vec embedded replica   ← 외부 조건 미확인, 권장하지 않음
```

---

## 6. 경로 B 를 실제로 갈 때의 작업 순서

1. `libsql` 계정에 붙어 **sqlite-vec 가용 여부와 버전**을 먼저 실측한다.
   안 되면 네이티브 `F32_BLOB` 로 확정 (이게 더 낫다).
2. `metadata/store/metadata-store.contract.ts` 용 하네스를 직접 작성한다
   (오픈소스 릴리스에 `*.test.ts` 가 **0개**다). SQLite 백엔드로 먼저 green 을 만든다.
3. `LibsqlMetadataStore` 를 만들고 같은 계약을 통과시킨다. ← 여기서 드라이버
   에러 메시지 정규식(`sqlite-adapter.ts:76`) 함정이 잡힌다.
4. `IMemoryStore` 용 계약 테스트는 **없다.** `sqlite.ts` 를 레퍼런스로 직접 써야 한다.
5. `LibsqlMemoryStore` 작성. `searchL1Vector` / `searchL0Vector` 를 JOIN 1회로 재작성.
6. 백엔드 스위치 4곳 수정.
7. Skill 은 마지막. `getRawDb()` 없으면 자동 스킵되므로 급하지 않다.
