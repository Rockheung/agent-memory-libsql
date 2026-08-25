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

현재 브랜치:

| 브랜치 | 상태 |
|---|---|
| `rock/main` | 트렁크 |
| `feat/s3-storage-backend` · `feat/libsql-metadata-store` · `feat/libsql-memory-store` · `feat/m2-deployment` | 전부 `rock/main` 에 머지 완료 (기록용으로 남김) |
| `pr/proxy-auth-bearer` | upstream 행. `MemoryProxy` 3파일 +20 줄만 담음 |

`feat/m2-deployment` 는 원래 `feat/proxy-auth-bearer` 였다 — 실제 내용이 M2
배포라 2026-08-25 에 개명했다. `pr/` 쪽과 이름이 겹쳐 헷갈리기도 했다.

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

3. **`sdk/` 는 건드리지 않는다.** upstream 그대로 쓴다.

   ~~`MemoryProxy/` 도 건드리지 않는다~~ — 2026-08-25 에 깼다. 이유:
   `verifyUserKey` 가 커널을 부를 때 `Authorization` 헤더를 보내지 않아,
   커널에 `TDAI_GATEWAY_API_KEY` 를 켜면 **모든 인증이 401 로 실패한다**
   (`MemoryProxy/src/auth.ts`). 우회가 "게이트웨이 인증을 끄는 것" 뿐이라
   보안을 포기하지 않으려면 고칠 수밖에 없었다.

   수정 3곳 (전부 후크 성격):
   | 파일 | 내용 |
   |---|---|
   | `src/types.ts` | `AuthConfig.apiKey` 필드 |
   | `src/auth.ts` | 있을 때만 `Authorization: Bearer` 부착 |
   | `src/config.ts` | 기본값 + `TDAI_GATEWAY_API_KEY` env 폴백 |

   **하위 호환된다** — `apiKey` 가 비면 헤더를 안 붙여 기존 배포와 동일하다.
   그래서 upstream PR 후보이기도 하다 (docs/ROADMAP.md U 트랙).

   2026-08-25, 이 3파일만 떼어 **`pr/proxy-auth-bearer`** 를 `feat/server_team`
   에서 새로 땄다 (커밋 `00e313c`, 4파일 +25/-0, 주석은 영문 —
   `config.example.yaml` 만 파일 언어에 맞춰 중문). upstream 기준 타입
   에러 6개는 이 변경 전후가 동일하다 — 전부 upstream 에 원래 있던 것이다.
   `MemoryProxy` 에는 테스트가 없다. PR 은 아직 열지 않았다.
4. 6곳을 넘겨야 할 일이 생기면 **먼저 upstream 에 seam Issue 를 던진다** (docs/ROADMAP.md U1 참조).

## 이 포크가 뭘 하는 것인가 (프레임 고정)

**upstream 의 구조를 가져와 스토리지 계층을 이식하는 것**이다. upstream 에 기여하지
않는다 — PR·이슈·푸시 전부 하지 않는다. `upstream` 리모트는 push URL 을
`DISABLED_NO_PUSH_TO_UPSTREAM` 으로 막아뒀다 (fetch 는 살아있다).

따라서 upstream 파일 수정의 품질 지표는 **"PR 로 낼 만한가" 가 아니라
"다음 릴리스 드롭에서 살아남는가" 다.** 아래를 지표로 쓴다.

### 리베이스 노출도 (2026-08-25 실측)

upstream 은 최근 20 커밋 중 **실제 코드 드롭이 3 번**이고 전부 스쿼시 대량
투하다 (`v2.0.1-beta.1` = 160 파일 +20,172). 우리 캐리 패치가 그 드롭에서
몇 번 피격됐는지:

| 파일 | 우리 변경 | 3드롭 중 피격 |
|---|---|---|
| `MemoryCore/src/gateway/server.ts` | +37/-7 | **3** |
| `MemoryCore/src/core/tdai-core.ts` | +27/-6 | **3** |
| `MemoryCore/src/core/skill/types.ts` | +3/-3 | **3** |
| `MemoryProxy/src/types.ts` · `config.ts` | +15 | **3** |
| `MemoryCore/package.json` | +2 | 3 |
| `core/storage/types.ts` · `metadata/store/interface.ts` · `utils/pipeline-factory.ts` | +18/-2 | 2 |
| 나머지 6개 (팩토리·store-pool·manifest·config) | +197/-15 | 1 |

**덩치 큰 둘(`gateway/server.ts`, `tdai-core.ts`)이 매 드롭 피격 파일에 있다.**
리베이스 시 여기부터 본다.

### 리베이스 절차

진짜 방어선은 패치가 아니라 **이식이 살아있는지 증명하는 테스트**다.
`git rebase feat/server_team` 후 반드시 아래를 통과시킨다.

```bash
cd MemoryCore
npx vitest run src/metadata/store/                    # 계약 96 (sqlite 48 + libsql 48). 격리됨
npx tsx src/core/store/__libsql-store.e2e.ts          # 메모리 스토어 7
npx tsx src/core/skill/__libsql-skill-store.e2e.ts    # 스킬 스토어 10
npx tsx src/core/skill/__skill-gateway.e2e.ts         # 스킬 HTTP 5
node   src/core/storage/__s3-backend.itest.mjs        # S3 백엔드 16
```

`__` 접두사라 vitest include 에 안 걸린다 — 위처럼 직접 실행해야 한다.
계약 테스트만 `:memory:` 라 안전하고, **나머지 4개는 자격증명 파일
(`~/.config/turso.env`, `~/.config/oci-s3.env`)을 읽어 실제 운영 Turso/S3 를
친다.** 삭제는 하지 않지만 테스트 레코드가 남는다. 운영 데이터가 신경 쓰이면
Turso 브랜치를 하나 파서 URL 만 바꿔 돌릴 것.

하나라도 깨지면 그 드롭은 **이식이 깨진 것**이지 충돌 해소 실패가 아니다.
docs/09·11 의 함정(트랜잭션 핸들, WHERE 없는 DELETE)을 다시 읽을 것.

## 라이선스

MIT (원본 유지). 이 포크의 추가분도 MIT.
