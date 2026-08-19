# ⑧ Turso 스파이크 결과 — 2,700 LOC 착수 전 가정 검증

실행일 2026-08-20 / 대상 `libsql://memd-rockheung.aws-ap-northeast-1.turso.io` (도쿄, 무료 플랜)
드라이버 `@libsql/client@0.15.15` / 측정 위치: Mac (LAN → 도쿄)

**판정: 9/9 통과. 설계를 바꿀 만한 장애물이 없다.**

---

## 결과

| # | 검증 | 결과 |
|---|---|---|
| 1 | `F32_BLOB(1024)` + `libsql_vector_idx` + `vector_top_k` | ✅ 무료 플랜에서 동작 |
| 2 | FTS5 `MATCH` + `bm25 rank` | ✅ |
| 3 | `transaction()` + `rollback()` | ✅ |
| 4 | **UNIQUE 위반 에러 메시지 포맷** | ✅ **upstream 정규식과 정확히 일치** |
| 5 | 부분 유니크 인덱스 (`WHERE deleted_at IS NULL`) | ✅ |

환경: SQLite 3.47.0

### ★ 4번이 가장 큰 리스크였고, 깨끗하다

`metadata/store/sqlite-adapter.ts:76` 이 PK 충돌을 **에러 문자열 정규식**으로 판정한다.
드라이버가 바뀌면 조용히 깨지는 함정이었다.

```
실제 메시지: "SQLITE_CONSTRAINT: SQLite error: UNIQUE constraint failed: meta_users.user_id"
e.code: SQLITE_CONSTRAINT
정규식: /UNIQUE constraint failed: meta_\w+\.(user_id|team_id|...)/  →  매칭 ✅
```

**`isPkCollision()` 을 그대로 쓸 수 있다.** 재시도 로직을 손대지 않아도 된다.

### ★ FTS5 내장 → 스키마 절반이 무수정

`l1_fts` / `l0_fts` / `skill_fts` 가 **그대로 간다.** 재작성 대상은 `vec0` 두 개(`l1_vec`, `l0_vec`) 뿐이다.
당초 3,000 LOC 추정에서 실질 범위가 줄었다.

---

## 성능 실측 (2,000건 적재 기준)

```
정상상태 KNN (k=20, JOIN 포함)   중앙값 67ms   min 56 / max 335
콜드스타트 첫 쿼리                 307ms
단순 SELECT 1 왕복                 42ms
batch INSERT                       ~33ms/행 (200건 6.7초)
```

**회상 경로 영향:**
```
현재   임베딩(bge-m3, 200ms~2s) + 로컬 KNN(µs)     ≈ 250ms
Turso  임베딩 + 원격 KNN 67ms                       ≈ 320ms
```
훅 예산이 6초라 여유가 크다. **+67ms 는 수용 가능.**

⚠️ **쓰기는 느리다.** 33ms/행이라 `reindexAll()`(전량 재임베딩)은 수천 건이면 수 분이다.
차원 변경 시 전량 재인덱싱이 돌므로(`sqlite.ts` needsReindex 경로) **임베딩 모델은 처음에 확정할 것.**

## ⚠️ over-fetch 는 사라지지 않는다 — 앞선 서술 정정

`02-TURSO-FEASIBILITY.md` 에서 "격리 필터를 SQL 로 내리면 over-fetch 가 사라진다"고 썼는데
**부정확했다.** `vector_top_k` 는 ANN 인덱스 스캔이라 `team_id` 로 **사전 필터를 못 한다.**
WHERE 는 top-k 를 뽑은 **뒤에** 걸린다.

팀 4개 분산(히트율 25%)에서 목표 5건을 얻으려면:

| k | 확보 | 지연 |
|---|---|---|
| 5 | 2건 ❌ | 55ms |
| 10 | 3건 ❌ | 56ms |
| **20** | **5건 ✅** | 61ms |
| 40 | 5건 ✅ | 70ms |
| 80 | 5건 ✅ | 59ms |

**다행히 지연이 k 에 거의 무관하다** (55~70ms). over-fetch 배수를 넉넉히 잡아도 공짜다.

그래도 현재 구현 대비 개선은 분명하다:

| | 현재 (sqlite.ts) | libSQL |
|---|---|---|
| 왕복 | 후보 1건당 SQL 1회 (**N+1**) | **1회** |
| 필터 | JS `rowMatchesIsolation()` | **SQL WHERE** |
| over-fetch | 필요 (5배 하드코딩) | 필요 (설정 가능) |

원격 DB 에서 N+1 은 치명적이므로, **JOIN 재작성은 선택이 아니라 필수**다.

---

## 남은 미검증

- **동시성** — 훅이 여러 머신에서 동시에 칠 때. 무료 플랜 동시 연결 제한 미확인
- **쿼터** — 읽기 500M / 쓰기 10M 행·월. 스파이크로 ~2,600행 썼다. 실사용 추정 필요
- **`vector_top_k` 재현율** — ANN 이라 정확도 손실이 있다. 현재 sqlite-vec 대비 비교 미실시

## 결론

```
착수해도 된다. 순서:

0. IStorageBackend  S3 어댑터     ~300 LOC   md/jsonl/checkpoint/로그 전부
1. LibsqlMetadataStore            ~400 LOC   계약테스트 854줄로 검증 공짜
2. LibsqlMemoryStore              ~2,000 LOC FTS5 무수정, vec0 만 재작성
3. (선택) LibsqlSkillStore        ~700 LOC   없으면 Skill 자동 비활성
```
