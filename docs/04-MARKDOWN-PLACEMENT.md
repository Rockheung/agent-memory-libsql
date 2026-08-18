# 코드레벨 분석 ⑤ L2/L3 마크다운은 어디에 두는가

> "DB만 중앙화하면 L2/L3 페르소나가 갈라진다"는 앞 문서의 지적에 대한 답.
> 결론부터: **선택지가 4개가 아니라 3개고, 그중 하나는 코드를 안 건드린다.**

---

## 0. 먼저 — 마크다운은 "한 군데"에 있지 않다

파이프라인을 읽으면 L2/L3 는 **항상 3단계 사이클**로 돈다
(`utils/pipeline-factory.ts:793,866,1000,1042`):

```
① pullProfilesToLocal()      원격 → 로컬 파일 (baseline 스냅샷 확보)
② L2/L3 생성                  로컬 파일을 읽고 쓴다 (fs 또는 StorageAdapter)
③ syncLocalProfilesToStore()  로컬 → 원격 (변경분만, 낙관적 락)
```

`syncLocalProfilesToStore` (`core/profile/profile-sync.ts:454`):
```ts
const syncRecords = localProfiles
  .filter(p => baselineMap.get(p.id)?.contentMd5 !== p.contentMd5 || !baselineMap.has(p.id))
  .map(p => ({ ...p, baselineVersion: baselineMap.get(p.id)?.version }));
if (syncRecords.length > 0 && store.syncProfiles) await store.syncProfiles(syncRecords);
```

즉 **로컬 파일은 언제나 작업 사본이다.** 질문은 "마크다운을 어디에 두나"가 아니라
**"동기화의 source of truth 를 어디에 두나"** 다.

그리고 이 사이클은 `store.pullProfiles` 가 **있을 때만** 돈다
(`profile-sync.ts:265`: `if (!store.pullProfiles) return new Map();`).

---

## 1. 결정적 사실: SQLite 스토어는 profile 동기화를 구현하지 않는다

| 스토어 | `pullProfiles` | `syncProfiles` | `deleteProfiles` |
|---|---|---|---|
| `VectorStore` (sqlite.ts, 3,835 LOC) | ❌ **없음** | ❌ 없음 | ❌ 없음 |
| `TcvdbMemoryStore` (tcvdb.ts) | ✅ `:1449` | ✅ `:1540` | ✅ `:1624` |

`IMemoryStore` 에서 이 5개 메서드는 전부 **optional** 이다 (`core/store/types.ts:~700`).

**그래서 지금 sqlite 모드에서 L2/L3 마크다운은 `IStorageBackend` 가 가리키는 곳에만 있다.**
DB 에는 한 글자도 안 들어간다. 반대로 TCVDB 모드에서는 마크다운 본문이
`ProfileRecord.content` 로 **DB 안에 들어간다** — `contentMd5` + `version` +
`baselineVersion` 낙관적 락까지 붙여서.

```ts
export interface ProfileRecord {
  id: string;                 // profile:v1:sha256(scope \0 type \0 filename)
  type: "l2" | "l3";
  filename: string;
  content: string;            // ← 마크다운 본문 그 자체
  contentMd5: string;
  teamId?: string; agentId?: string;
  version: number;
  createdAtMs: number; updatedAtMs: number;
}
```

---

## 2. 선택지 3개

### 안 A. Gateway 로컬 FS — **권장**

```
memory-core 컨테이너 :8420
  /data/tdai-memory/
    persona.md                  ← L3
    scene_blocks/*.md           ← L2
    conversations/*.jsonl       ← L0 원본
    records/*.jsonl             ← L1 원본
    .metadata/scene_index.json
    .backup/persona/persona.N.md
    vectors.db  metadata.db
```

- 코드 수정 **0**. `LocalStorageBackend` 가 기본값.
- Gateway 를 한 대로 모으는 순간 **마크다운도 자동으로 한 군데**가 된다.
  별도 오브젝트 스토리지가 애초에 필요 없다.
- `pullProfiles` 가 없어도 무방하다 — 원격 동기화 사이클 자체가 필요 없으니까.
  파일이 곧 원본이다.
- 백업 = named volume 스냅샷 하나. `vectors.db` / `metadata.db` / 마크다운이
  **같은 볼륨 안에 있어서 시점 일관성이 자동으로 맞는다.**

> 마지막 항목이 생각보다 크다. DB 와 마크다운을 서로 다른 시스템에 두면
> "L2 블록은 새 버전인데 scene_index 는 옛 버전" 같은 스큐가 백업/복구 시점에 생긴다.
> 한 볼륨에 두면 그 문제가 존재하지 않는다.

### 안 B. S3 / R2 오브젝트 스토리지 어댑터

`IStorageBackend` 는 **처음부터 전부 async** 라서 어댑터 하나면 끝난다.
구현할 메서드는 8개:

```
putObject  appendObject  getObject  exists
listObjects  deleteObject  deleteByPrefix  + readonly type
```

구현 시 실제로 걸리는 것 4가지:

1. **`appendObject` 는 S3/R2 에 없다.**
   다만 오픈소스 트리에서 `appendObject` **호출부가 0개**다
   (`StorageAdapter.appendFile` 만 감싸고 있고 그 위 호출자가 없음).
   → `throw new Error("append unsupported")` 로 두고 시작해도 된다.

2. **`type` 은 `"local" | "cos"` 유니온이다** (`core/storage/types.ts:99,212`).
   분기하는 곳은 딱 2군데:
   - `core/hooks/auto-recall.ts:232` — `useCos` 가 scene navigation 의
     경로 렌더링을 로컬 절대경로 vs 오브젝트 키로 바꾼다
   - `core/memory-generation-log/store.ts:97` — `local` 일 때만
     `instances/{id}` 스코프 프리픽스를 덧댄다 (COS 는 자격증명이 프리픽스를 이미 들고 있음)

   → **S3 어댑터는 `type: "cos"` 로 신고하는 게 의미상 맞다.** 유니온을 넓히지 말 것.
     넓히면 위 2개 분기를 다 손봐야 한다.

3. **`rename` 이 원자적이지 않다** (`core/storage/adapter.ts:~205`).
   get → put → delete 3단계고, 주석이 스스로 인정한다:
   > *"if the process is killed between put and delete, both source and dest will exist
   > (data duplication). Tracked as audit report H-6 (persona.md backup rotation)."*

   persona 백업 로테이션(`.backup/persona/persona.N.md`)이 이걸 쓴다.
   로컬 FS 는 POSIX rename 이라 안전하지만, **S3 로 가면 이 알려진 버그를 실제로 밟는다.**

4. `listObjects` 의 `marker` 페이지네이션과 `isDirectory`(common prefix) 시맨틱을
   맞춰야 한다. `readdir` 은 `maxKeys: 10000` 을 때린다 (`adapter.ts:~131`).

**평가: 200~400 LOC. 하지만 안 A 를 이미 했다면 얻는 게 "볼륨 백업 대신 R2 라이프사이클"
정도다.** 그리고 3번 때문에 오히려 안정성이 내려간다.

### 안 C. DB 안에 넣기 — `pullProfiles`/`syncProfiles` 구현

`LibsqlMemoryStore` 를 쓰기로 했다면 (02 문서 경로 B), **이 5개 optional 메서드를
같이 구현하는 게 맞다.** 그러면 마크다운이 Turso 안으로 들어간다.

```sql
CREATE TABLE profiles (
  id            TEXT PRIMARY KEY,   -- profile:v1:sha256(scope \0 type \0 filename)
  type          TEXT NOT NULL,      -- 'l2' | 'l3'
  filename      TEXT NOT NULL,
  content       TEXT NOT NULL,      -- ← 마크다운 본문
  content_md5   TEXT NOT NULL,
  team_id       TEXT, agent_id TEXT,
  version       INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
```

`syncProfiles` 는 `baselineVersion` 을 받아 낙관적 락을 걸어야 한다
(`UPDATE ... WHERE version = ?`). 프로토콜이 이미 정의돼 있어서 설계 여지가 없다 —
그대로 따르면 된다.

**장점:** 오브젝트 스토리지가 아예 필요 없어진다. DB 하나에 L0/L1/L2/L3 전부.
백업도 하나. TCVDB 가 정확히 이 모델로 돌고 있으니 검증된 경로다.

**단점:** 마크다운을 `git diff` 하거나 에디터로 직접 고치는 게 불가능해진다.
로컬 파일은 캐시일 뿐이고, 다음 `pullProfilesToLocal` 이 덮어쓴다.

---

## 3. 비교

| | 안 A 로컬 FS | 안 B S3/R2 | 안 C DB 내부 |
|---|---|---|---|
| 코드 작업 | **0** | 200~400 LOC | `LibsqlMemoryStore` 에 5메서드 추가 |
| 오브젝트 스토리지 필요 | ❌ | ✅ | ❌ |
| DB↔마크다운 백업 일관성 | **자동** (한 볼륨) | 수동 조율 필요 | **자동** (한 DB) |
| 사람이 직접 편집/git 관리 | ✅ 쉬움 | △ | ❌ (덮어써짐) |
| 알려진 버그 밟음 | 없음 | rename 비원자성 (H-6) | 없음 |
| 게이트웨이 다중화 | ❌ 한 대 고정 | ✅ | ✅ |

**게이트웨이를 여러 대 띄울 게 아니면 안 A 가 압도적으로 낫다.**
홈랩에서 memory-core 를 2대 이상 띄울 이유는 없다.

---

## 4. ⚠️ 그런데 진짜 중요한 건 이거다 — `agentId` 를 나누면 안 된다

`core/profile/profile-sync.ts:20`:

```ts
export function buildProfileIsolationScope(ctx?: ProfileIsolation): string {
  const teamId  = ctx.teamId || ctx.userId || "default";
  const agentId = ctx.agentId || "default";
  // L2/L3 are team+agent-level memories. L0/L1 keep user/session/task-level
  // isolation, but profiles intentionally ignore userId/sessionId/taskId so
  // one team's agent memory can accumulate across multiple sessions/users.
  return `team:${teamId}|agent:${agentId}`;
}
```

**L2/L3 의 정체성은 `(teamId, agentId)` 쌍이다.** userId / sessionId / taskId 는
의도적으로 무시한다.

→ 앞 문서(03)에서 머신별로 `agentId: "claude-mac"` / `"codex-gpu1"` 처럼 나눠 준
예시는 **L2/L3 페르소나를 머신 수만큼 쪼갠다.** 마크다운을 어디에 두든 상관없이 쪼개진다.
그 설정 예시는 아래처럼 고쳐야 한다.

```jsonc
// 모든 머신이 동일하게
{ "teamId": "rock", "agentId": "rock-agent",
  "userId": "rock" }        // L0/L1 은 sessionId 로 알아서 갈린다
```

- **하나의 페르소나를 공유하고 싶다** → 모든 머신이 `teamId` + `agentId` 를 **같게**
- **머신별로 다른 인격을 원한다** → `agentId` 를 다르게 (그러면 L2/L3 가 N벌 생김)

L0/L1 은 `team/user/agent/session/task` 5차원으로 여전히 구분되므로
"어느 머신에서 나온 대화인가"는 세션 메타로 추적할 수 있다. 인격만 공유된다.

---

## 5. 결론

```
게이트웨이 1대 = 마크다운도 이미 중앙화됨.  ← 추가 작업 0

오브젝트 스토리지는 다음 중 하나일 때만 꺼낸다:
  · memory-core 를 2대 이상 띄운다
  · 볼륨 스냅샷 대신 R2 라이프사이클로 백업을 돌리고 싶다

Turso 로 갈 거면 → 오브젝트 스토리지 대신 안 C (DB 안에 넣기).
  IStorageBackend 어댑터를 새로 쓰는 것보다,
  이미 규격이 정의된 pullProfiles/syncProfiles 5개를 구현하는 게 싸고 안전하다.

그리고 무엇을 고르든:  agentId 를 머신별로 나누지 마라.
```
