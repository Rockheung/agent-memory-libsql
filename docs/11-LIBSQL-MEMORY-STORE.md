# ⑫ LibsqlVectorStore — L0/L1 + 벡터를 Turso 로

브랜치 `feat/libsql-memory-store` / 2026-08-21

**상태: 실제 Turso 대상 e2e 7/7 통과.** 타입 오류 0.

---

## 무엇이 달라졌나

`sqlite.ts`(3,835 LOC)에서 파생. 차이는 넷뿐이다.

| | 원본 | libSQL |
|---|---|---|
| 드라이버 | `node:sqlite` DatabaseSync (동기) | `@libsql/client` (비동기) |
| 벡터 | sqlite-vec `vec0` 가상테이블 | 네이티브 `F32_BLOB` + `libsql_vector_idx` + `vector_top_k` |
| KNN | 후보마다 메타 조회 (**N+1**) | **단일 JOIN** |
| 격리 필터 | JS `rowMatchesIsolation()` 사후판정 | **SQL WHERE** |

**FTS5 는 한 글자도 안 건드렸다.** libSQL 내장이라 `l1_fts` / `l0_fts` 스키마와 쿼리가 그대로 간다.

## 설계 결정

### 벡터를 별도 테이블에 유지

`l1_records` 에 임베딩 컬럼을 넣는 대신 `l1_vec` 을 일반 테이블로 남겼다.
원본의 **"upsert = delete + insert"** 경로와 **만료 삭제**(`updated_time` 기준)를
그대로 쓸 수 있어서다. 스파이크로 `TEXT PRIMARY KEY` 테이블에서도
`vector_top_k` → `rowid` JOIN 이 되는 것을 먼저 확인했다.

```sql
SELECT v.record_id, vector_distance_cos(v.embedding, vector32(?)) AS distance, m.*
FROM vector_top_k('l1_vec_idx', vector32(?), ?) AS k
JOIN l1_vec v ON v.rowid = k.id
JOIN l1_records m ON m.record_id = v.record_id
WHERE v.embedding IS NOT NULL AND m.team_id = ?     -- 격리를 SQL 로
ORDER BY distance
```

### Stmt shim — 호출부 90곳을 안 건드린다 ★

원본은 준비된 statement 를 필드에 담고 `this.stmtX.run(a, b)` 로 쓴다(호출부 90곳+).
`@libsql/client` 에는 prepare 가 없다. SQL 을 클로저에 담은 얇은 객체를 돌려주면
**호출부 모양이 유지되고 `await` 만 붙이면 된다.**

```ts
class Stmt {
  constructor(private db: () => Client, private sql: string) {}
  async run(...args) { ... }  async get(...args) { ... }  async all(...args) { ... }
}
```

### 트랜잭션 — `this.db` 를 게터로 ★

원본은 22곳에서 `db.exec("BEGIN")` 으로 트랜잭션을 직접 연다.
`@libsql/client` 는 문자열 BEGIN/COMMIT 을 커넥션 단위로 추적하지 않아
**`cannot commit - no transaction is active`** 가 난다 (메타데이터 어댑터에서도 같은 함정).

22개 블록을 재구조화하는 대신, `this.db` 를 **게터**로 만들어
트랜잭션 중이면 핸들을, 아니면 원 커넥션을 돌려주게 했다. 그러면
`BEGIN/COMMIT/ROLLBACK` 문장 44개를 `begin()/commit()/rollback()` 호출로
**치환만** 하면 되고 블록 구조는 그대로다. 중첩 BEGIN 은 깊이 카운터로 흡수한다.

---

## e2e 결과 (실제 Turso)

```
init (스키마+인덱스 생성)   3.8s
capabilities                vectorSearch ✅ ftsSearch ✅
L0 12건 적재                ✅
L0 KNN                      55ms — 1위 정확, score 1.0000
격리 필터                   ✅ 5건 전부 team-B (SQL WHERE)
FTS5                        ✅ 5건
L1 KNN                      ✅ 정확
```

## 변환에서 배운 것

기계적 변환의 한계가 메타데이터 때보다 뚜렷했다. 정규식이 **인터페이스 선언과
모듈 스코프 함수까지 오염**시켜 `interface JiebaInstance { async cutForSearch... }`
같은 게 나왔고, 과도한 삭제 정규식이 `getRawDb()` / `prepare()` **선언 줄을 통째로
날렸다.** 타입체커가 전부 잡았지만, 이런 변환은 **타입체크 없이는 불가능**하다.

그리고 타입체크만으로는 부족했다 — 타입 오류 0인 상태에서 e2e 를 돌리자
쓰기가 전부 실패했다(트랜잭션 문제). **두 겹의 검증이 다 필요했다.**

## 남은 것

- [ ] `StoreBackend` 유니온에 `"libsql"` + `core/store/factory.ts` / `store-pool.ts` 배선
- [ ] `getRawDb()` 가 `Client` 를 돌려주므로 Skill 모듈(`SqliteSkillStore`)은 호환 안 됨 →
      현재는 skill wiring 이 스킵된다. 별도 `LibsqlSkillStore` 필요
- [ ] `reindexAll()` 경로 실측 (쓰기 33ms/행이라 대량 재임베딩은 느리다)
- [ ] 동시 접근 / 무료 플랜 연결 수 제한
