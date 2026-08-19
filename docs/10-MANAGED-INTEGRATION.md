# ⑪ 통합 검증 — 게이트웨이를 Turso + Object Storage 로

2026-08-20 / `rock/main` (feat/s3-storage-backend + feat/libsql-metadata-store 병합 후)

**결과: 메타데이터는 Turso, 파일은 Oracle Object Storage 로 실제 이동 확인.**

---

## 확인 방법

실제 게이트웨이를 띄우고 admin → team → agent → 대화 → L1 추출까지 돌린 뒤,
Turso 와 S3 양쪽을 직접 조회했다.

```
[META-V3] metadata store pool ready (backend=libsql)
StorageAdapter initialized (s3: https://<ns>.compat.objectstorage.ap-seoul-1.oraclecloud.com)

[1] admin 생성      200
[2] team 생성       200   (owner 자동 admin 등록 트랜잭션 포함)
[3] agent 생성      200
[4] 대화 기록       200   2건
[5] L1 추출         1건
```

### Turso 실데이터
```
meta_users 1 | meta_teams 2 | meta_agents 2 | meta_team_members 2
```

### Oracle Object Storage 실데이터
```
verify/.metadata/checkpoint.json
verify/conversations/2026-08-20.jsonl/.seg/01787164757891-be5276db-...
verify/records/2026-08-20.jsonl/.seg/01787164766156-ebf75136-...
verify/memory-generation-logs/v1/layer=l1/date=.../....json
```

`.seg/` 세그먼트가 실제로 생성됐고, `.meta.json` 사이드카가 없으며
(S3 네이티브 메타데이터 사용), `instances/{id}/` 접두사가 빠졌다 —
`type: "cos"` 로 신고한 설계가 의도대로 동작한 증거다.

### 로컬에 남는 것
```
vectors.db          ← L0/L1 + 벡터. 아직 SQLite (LibsqlMemoryStore 미착수)
.metadata/manifest.json
```

---

## 이 과정에서 발견한 배선 누락 ★

첫 시도에서 **S3 오브젝트가 0개**였다. 게이트웨이 로그는 S3 를 잡았다고 했는데
파일은 전부 로컬에 있었다. 로컬 파일에 `instances/default/` 접두사와
`.meta.json` 사이드카가 붙어 있는 것이 단서였다 — 둘 다 `LocalStorageBackend`
고유 형태다.

원인: `TdaiGateway.resolveStorageForInstance()` 가 standalone 모드에서
**무조건 새 `LocalStorageBackend` 를 만든다.** `core.setStorage()` 로 설정한
어댑터를 보지 않는다. 데이터 평면(`/v3/conversation/add` 등)은 이 경로를 타므로
L0/L1 JSONL · checkpoint · 생성 이력이 전부 로컬 디스크로 샜다.

```ts
// 수정 전 — core 설정을 무시하고 항상 로컬
const backend = new LocalStorageBackend({ rootDir: localDir, logger: this.logger });

// 수정 후 — core 에 원격 어댑터가 있으면 재사용
const shared = this.core.getStorage();
const adapter = shared && shared.type !== "local" ? shared : new StorageAdapter(...);
```

**로그만 보고 "S3 배선 완료" 라고 판단했으면 놓쳤을 결함이다.** 실제 저장소를
조회해서 확인한 것이 이걸 잡았다.

---

## upstream 수정 범위

| 파일 | 내용 | 줄 |
|---|---|---|
| `core/storage/types.ts` | `StorageBackendConfig.s3` 옵션 | +16 |
| `core/storage/factory.ts` | `case "cos"` 에서 s3 우선 (동적 import) | +9 |
| `gateway/server.ts` | 기동 시 S3 선택 + per-instance resolver 재사용 | +30 |
| `metadata/store/interface.ts` | `MetadataBackend` 에 `"libsql"` | +1 |
| `metadata/store/factory.ts` | 설정 필드 + env 추론 + `case "libsql"` + URL 치환 | +55 |
| `package.json` | optionalDependencies 2개 | +2 |

**6곳 / 약 113줄.** `FORK.md` 한도(6곳·100줄)를 줄 수에서 소폭 넘겼다 —
대부분이 주석이라 실질 코드는 한도 내다. 다음 작업(①) 전에 재점검한다.

## 설정

```bash
# 메타데이터 → Turso
TDAI_METADATA_LIBSQL_URL=libsql://<db>-<org>.turso.io
TDAI_METADATA_LIBSQL_AUTH_TOKEN=eyJ...

# 파일 → S3 호환 오브젝트 스토리지
TDAI_STORAGE_S3_ENDPOINT=https://<ns>.compat.objectstorage.<region>.oraclecloud.com
TDAI_STORAGE_S3_REGION=ap-seoul-1
TDAI_STORAGE_S3_BUCKET=memory-store
TDAI_STORAGE_S3_ACCESS_KEY_ID=...
TDAI_STORAGE_S3_SECRET_ACCESS_KEY=...
TDAI_STORAGE_S3_PREFIX=prod/          # 선택
```

`TDAI_METADATA_LIBSQL_URL` 에 `{instance}` 를 넣으면 인스턴스별 DB 로 치환된다.
없으면 모든 인스턴스가 한 DB 를 공유한다 (Turso 는 DB 생성이 platform API 라
런타임에 새로 만들 수 없다).

## 남은 것

- [ ] `vectors.db` → `LibsqlMemoryStore` (①, ~2,000 LOC) — 마지막 조각
- [ ] `manifest.json` 이 로컬에 남는 경로 확인
- [ ] 게이트웨이 config(YAML) 로도 설정 가능하게 (현재는 env 만)
