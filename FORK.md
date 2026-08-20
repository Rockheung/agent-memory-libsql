# 이 레포에 대하여

`TencentCloud/TencentDB-Agent-Memory` 의 포크.
원본은 MIT 라이선스이며 `LICENSE` 를 그대로 유지한다.

## 목적

에이전트 기억을 여러 머신(Mac / GPU-1 / GPU-2 / Pi)에서 공유하기 위한 작업 저장소.

1. upstream 을 **설정만으로** 중앙화해서 쓸 수 있는지 검증 (M0)
2. 되지 않는 부분에 한해 **libSQL/Turso 백엔드**를 추가 (M1~)

분석 근거와 판정은 [`docs/`](docs/README.md) 6편에 있다.
작업 계획은 [`docs/ROADMAP.md`](docs/ROADMAP.md).
(루트 `ROADMAP.md` 는 upstream 것이므로 건드리지 않는다.)

## 브랜치 규약

| 브랜치 | 용도 | 규칙 |
|---|---|---|
| `feat/server_team` | **upstream 미러.** upstream 의 기본 브랜치를 그대로 추적 | **절대 커밋 금지** |
| `rock/main` | 이 포크의 작업 트렁크 | docs / ROADMAP / 통합 |
| `feat/*` | 기능 작업 | `rock/main` 에서 분기 |
| `pr/*` | upstream 에 보낼 PR | **`feat/server_team` 에서 분기** (내 커밋 섞이면 안 됨) |

```bash
git remote -v
# origin    https://github.com/Rockheung/agent-memory-libsql.git
# upstream  https://github.com/TencentCloud/TencentDB-Agent-Memory.git

# upstream 동기화
git fetch upstream
git checkout feat/server_team && git merge --ff-only upstream/feat/server_team
git checkout rock/main && git rebase feat/server_team
```

## 포크 위생 규칙 (rebase 비용을 낮게 유지하기 위한 것)

upstream 은 **스쿼시된 릴리스 드롭**으로 코드를 떨군다 (`feat: release v2.0.1-beta.2`).
따라서 upstream 파일을 수정할수록 rebase 가 비싸진다.

1. **새 기능은 새 파일로.** `core/store/libsql.ts` 처럼 추가만 한다.
2. **upstream 파일 수정은 "백엔드 후크"에만 한다.**

   초판에는 "6곳 · 100줄 미만" 이라고 썼는데, 실제로 세 백엔드(S3 / libSQL 메타 /
   libSQL 메모리 + Skill)를 붙이고 재보니 **12곳 · +258줄**이었다. 숫자를 지키지
   못했으니 숫자를 고친다 — 지키지 않는 규칙을 남겨두는 것보다 낫다.

   중요한 건 줄 수가 아니라 **성격**이다. 아래 12곳은 전부
   "switch 에 case 추가 / 유니온에 값 추가 / 설정 필드 추가" 뿐이고,
   upstream 이 스스로 백엔드를 늘릴 때 건드릴 바로 그 자리다. 그래서
   충돌이 나도 해소가 기계적이다.

   | 파일 | 성격 | 실측 |
   |---|---|---|
   | `package.json` | optionalDependencies 2개 | +2 |
   | `config.ts` | `StoreBackend` 유니온 + `LibsqlConfig` 파싱 | +19/-2 |
   | `core/storage/types.ts` | `StorageBackendConfig.s3` | +16 |
   | `core/storage/factory.ts` | `case "cos"` 에서 s3 우선 | +8/-1 |
   | `core/store/factory.ts` | `case "libsql"` | +39/-2 |
   | `core/store/store-pool.ts` | `mode="libsql"` + 생성 분기 | +49/-5 |
   | `core/tdai-core.ts` | 백엔드별 SkillStore 선택 | +27/-6 |
   | `core/skill/types.ts` | `storeBackend` 유니온 | +3/-3 |
   | `gateway/server.ts` | S3 선택 + StorePool mode + storage 재사용 | +37/-7 |
   | `metadata/store/interface.ts` | `MetadataBackend` 유니온 | +1/-1 |
   | `metadata/store/factory.ts` | `case "libsql"` + env 추론 | +56/-3 |
   | `utils/pipeline-factory.ts` | `createStoreBundle` 에 await | +1/-1 |
   | `utils/manifest.ts` | `"libsql"` 타입 + diff 분기 | (본 커밋) |

   **새 수정 지점을 늘려야 하면 먼저 멈추고, 그게 정말 후크인지 따진다.**
   후크가 아닌 곳(로직 본문)을 고쳐야 한다면 upstream 에 seam Issue 를 먼저 던진다
   (docs/ROADMAP.md U1).

   신규 파일은 제한하지 않는다 — 충돌하지 않으므로 rebase 비용이 0 이다.
   현재 6,000 줄 이상이 add-only 다.

3. **`sdk/` 와 `MemoryProxy/` 는 건드리지 않는다.** upstream 그대로 쓴다.
4. 6곳을 넘겨야 할 일이 생기면 **먼저 upstream 에 seam Issue 를 던진다** (docs/ROADMAP.md U1 참조).

## 라이선스

MIT (원본 유지). 이 포크의 추가분도 MIT.
