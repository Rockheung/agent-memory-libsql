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
2. **upstream 파일 수정은 아래 6곳으로 제한한다.** 총 100줄 미만이어야 한다.

   | 파일 | 수정 내용 | 예상 |
   |---|---|---|
   | `MemoryCore/src/config.ts:183` | `StoreBackend` 유니온에 `"libsql"` | 1줄 |
   | `MemoryCore/src/config.ts:480` | 파싱 분기 | 2줄 |
   | `MemoryCore/src/core/store/factory.ts` | `switch` 에 `case "libsql"` | ~30줄 |
   | `MemoryCore/src/core/store/store-pool.ts` | `StoreMode` 확장 + `createLibsqlStore()` | ~40줄 |
   | `MemoryCore/src/metadata/store/interface.ts:201` | `MetadataBackend` 에 `"libsql"` | 1줄 |
   | `MemoryCore/src/metadata/store/factory.ts` | `case` 1개 (mongodb 처럼 dynamic import) | ~20줄 |

3. **`sdk/` 와 `MemoryProxy/` 는 건드리지 않는다.** upstream 그대로 쓴다.
4. 6곳을 넘겨야 할 일이 생기면 **먼저 upstream 에 seam Issue 를 던진다** (docs/ROADMAP.md U1 참조).

## 라이선스

MIT (원본 유지). 이 포크의 추가분도 MIT.
