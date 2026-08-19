# ⑩ LibsqlMetadataStore — 메타데이터를 Turso 로

브랜치 `feat/libsql-metadata-store` / 2026-08-20

**상태: 계약 테스트 48/48 통과 (SQLite 와 동일 스위트), 원격 Turso e2e 통과.**

---

## 먼저: 계약 테스트 하네스를 복원했다

upstream OSS 릴리스에는 `*.test.ts` 가 **0개**다. 계약 스위트 본체
`metadata-store.contract.ts` (854 LOC) 는 남아있고 **호출부만 제거**됐다.

`sqlite-adapter.test.ts` 를 복원해 **기준선 48/48** 을 먼저 확보한 뒤 이식했다.
이게 없었으면 1,818줄 변환의 정확성을 검증할 방법이 없었다.

## 동기 드라이버(`libsql`)를 쓰지 않은 이유 ★

`libsql` npm 패키지는 better-sqlite3 호환 **동기** API 를 제공하고, 놀랍게도
**원격 Turso 에 대해서도 동작한다.** 그러면 72개 메서드를 재작성하지 않고
드라이버만 교체하면 된다 — 매력적인 지름길이었다.

실측하고 버렸다:

```
동기 호출 지연            170ms   (@libsql/client async 는 42ms — 4배)
이벤트 루프 차단          873ms / 10회 호출
get() 반환에 _metadata    Object.keys 가 오염됨 (all() 은 안 그럼 — 비일관)
```

**게이트웨이가 모든 요청을 직렬화하게 된다.** 서버에서 쓸 수 없다.
→ `@libsql/client` (async) + 전면 async 화로 확정.

참고로 async 클라이언트의 행 형태는 깨끗하다: 컬럼명만, 여분 필드 없음,
INTEGER → number (BigInt 아님).

## 변환 방식

1,818줄 / 72개 public 메서드를 기계적으로 변환하고 계약 테스트로 검증했다.

| 단계 | 내용 |
|---|---|
| 드라이버 | `node:sqlite` DatabaseSync → `@libsql/client` createClient |
| 헬퍼 4종 | `get/all/run/tx` → async. SQL 문자열은 **한 글자도 안 건드림** |
| 메서드 | public 70 + private 5 + 제네릭 1 → async, 반환 `Promise<T>` |
| 호출부 | 헬퍼·내부 메서드 호출 약 30곳에 `await` 삽입 |
| 생성자 | `dbPath: string` → `{ url, authToken? }` |

### 기계적 변환이 놓친 것 — 타입체커와 테스트가 잡았다

| 문제 | 발견 |
|---|---|
| `this.tx(() => {...})` 콜백이 동기 | tsc TS1308 |
| `await this.get(...)!` → assertion 이 Promise 에 걸림 | tsc TS2322 |
| 다중행 `)!;` 형태 (정규식 미스) | tsc |
| 제네릭 `applyUpdate<T>` (정규식 미스) | tsc |
| `.map(id => await this.getAgentById(id))` | tsc → `Promise.all` 로 수정 |
| **수동 `BEGIN`/`COMMIT`/`ROLLBACK` 2블록** | **계약 테스트 8건 실패** ↓ |

### ★ 수동 트랜잭션이 핵심 함정이었다

`upsertConfigParam` 이 `db.exec("BEGIN")` 으로 트랜잭션을 직접 관리한다.
`@libsql/client` 는 문자열 BEGIN/COMMIT 을 커넥션 단위로 추적하지 않아
`cannot rollback - no transaction is active` 가 난다.
interactive transaction (`client.transaction()`) 을 써야 한다 → `tx()` 헬퍼로 치환.

**타입 체크로는 절대 안 잡히는 종류다.** 계약 테스트가 없었으면 놓쳤다.

### tx() 구현 노트

기존 72개 메서드는 `this.run(...)` 을 호출한다. 이들이 트랜잭션 안에서 돌게 하려고
콜백 실행 중에만 `this.db` 를 트랜잭션 핸들로 바꿔치기한다. 중첩 트랜잭션은
upstream 에도 없으므로 지원하지 않는다.

### relation-id 재시도 헬퍼

upstream `runWithGeneratedRelationId` 는 동기 콜백 전용이라 async rejection 을
try/catch 로 못 잡는다. **upstream 파일을 건드리지 않기 위해** async 판을
`libsql-adapter.ts` 안에 로컬로 뒀다.

---

## 원격 Turso 실측

```
init (스키마 생성 포함)   419ms
getAgentById              39ms
listTeamsByUser          299ms
createTeam (트랜잭션 포함) 정상 — owner 자동 admin 등록까지
PK 충돌 감지              정상 — isPkCollision 정규식이 원격에서도 매칭
```

계약 테스트는 **로컬 libSQL 파일**(`file:`)로 돌린다. 케이스마다 새 DB 를 만들어서
원격에 돌리면 느리고 쿼터를 먹는다. 원격은 별도 e2e 로 확인.

## upstream 수정 범위

**0곳.** 전부 신규 파일이다.

```
metadata/store/libsql-adapter.ts        신규 (sqlite-adapter 에서 파생)
metadata/store/libsql-adapter.test.ts   신규
metadata/store/sqlite-adapter.test.ts   신규 (하네스 복원)
```

`MetadataBackend` 유니온(`"sqlite" | "mongodb" | "mysql"`)에 `"libsql"` 을 넣고
팩토리에 case 를 추가하는 배선은 **다음 단계**다 — 그때 upstream 2곳을 건드린다.

## 남은 것

- [ ] `MetadataBackend` 에 `"libsql"` + `metadata/store/factory.ts` 에 case
- [ ] 원격 전용 동작 확인: 동시 접근, 무료 플랜 연결 수 제한
- [ ] `@libsql/client` 를 optional dependency 로 선언
