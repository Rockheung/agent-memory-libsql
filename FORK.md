# 이 레포에 대하여

`TencentCloud/TencentDB-Agent-Memory` 의 포크.
원본은 MIT 라이선스이며 `LICENSE` 를 그대로 유지한다.

## 목적

에이전트 기억을 여러 머신(Mac / GPU-1 / GPU-2 / Pi)에서 공유하기 위한 작업 저장소.

1. upstream 을 **설정만으로** 중앙화해서 쓸 수 있는지 검증 (M0)
2. 되지 않는 부분에 한해 **libSQL/Turso 백엔드**를 추가 (M1~)

분석 근거와 판정은 [`docs/`](docs/README.md) 13편에 있다.
작업 계획은 [`docs/ROADMAP.md`](docs/ROADMAP.md).
(루트 `ROADMAP.md` 는 upstream 것이므로 건드리지 않는다.)

## 브랜치 규약

| 브랜치 | 용도 | 규칙 |
|---|---|---|
| `feat/server_team` | **upstream 미러.** upstream 의 기본 브랜치를 그대로 추적 | **절대 커밋 금지** |
| `rock/main` | 이 포크의 작업 트렁크 | docs / ROADMAP / 통합 |
| `feat/*` | 기능 작업 | `rock/main` 에서 분기 |

upstream 에 보내는 브랜치는 **없다.** 아래 "이 포크가 뭘 하는 것인가" 참조.

현재 브랜치:

| 브랜치 | 상태 |
|---|---|
| `rock/main` | 트렁크 |
| `feat/s3-storage-backend` · `feat/libsql-metadata-store` · `feat/libsql-memory-store` · `feat/m2-deployment` | 전부 `rock/main` 에 머지 완료 (기록용으로 남김) |

`feat/m2-deployment` 는 원래 `feat/proxy-auth-bearer` 였다 — 실제 내용이 M2
배포라 2026-08-25 에 개명했다.

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
   | `utils/manifest.ts` | `"libsql"` 타입 + diff 분기 | +26/-2 |
   | `core/skill/skill-config.ts` | 유니온 리터럴에 `"libsql"` (2026-09-11 병합에서 추가) | +1/-1 |

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

   ⚠️ **검증 근거가 약하다.** upstream `MemoryProxy` 에는 테스트가 아예 없어
   (`npm test` = "No test files found") 이 수정의 근거는 oci-ko 실배포에서
   인증이 통과한 것뿐이다. 타입 에러 6 개는 이 변경 전후가 동일하다 — 전부
   upstream 에 원래 있던 것이다.

   upstream 은 프로덕션에서 `TDAI_GATEWAY_API_KEY` 를 켜지 않는다
   (`config.example.yaml` 주석에 그렇게 써있다). 그래서 이 버그를 안 밟는다.
   우리는 공인 IP 호스트라 켤 수밖에 없어서 드러났다.
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

### 업스트림 동기화 절차 (2026-09-11 개정 — 1회 실측 반영)

**rebase 가 아니라 merge 로 한다.** 이 포크는 upstream 에 아무것도 보내지
않으므로(위 "이 포크가 뭘 하는 것인가") 우리 커밋 50개를 하나씩 재적용해 같은
충돌을 여러 번 만날 이유가 없다. 초판에 적혀 있던 `git rebase feat/server_team`
은 폐기한다.

```bash
git fetch upstream
git checkout feat/server_team && git merge --ff-only upstream/feat/server_team
git checkout -b try/upstream-merge-YYYY-MM rock/main
git merge --no-commit --no-ff feat/server_team
```

진짜 방어선은 패치가 아니라 **이식이 살아있는지 증명하는 테스트**다.
아래를 순서대로 통과시킨다. 앞의 둘은 로컬에서, 뒤의 넷은 격리된 백엔드에서.

```bash
cd MemoryCore
npx tsdown                                            # 빌드. 임포트가 죽으면 여기서 걸린다
npx vitest run src/metadata/store/                    # 계약 116 (sqlite 58 + libsql 58). :memory: 라 안전
```

**타입체크는 절대값이 아니라 기준선과의 차이로 본다.** upstream 트리는
strict tsconfig 에서 원래 200건 넘게 난다(그쪽은 tsconfig 를 두지 않는다).
병합 전 커밋에 같은 설정으로 돌려 에러 집합을 비교하고, **포크 파일에 새
에러가 0 인지**만 본다. 2026-09-11 병합 실측: 기준선 232 → 221, 새로 생긴 21건은
전부 upstream 자기 코드.

나머지 넷은 실제 libSQL·S3 를 친다. **운영 sqld 를 절대 쓰지 말 것** —
`__skill-gateway.e2e.ts` 는 시작할 때 19개 테이블에 `DELETE FROM` 을 친다.
임시 인스턴스를 띄워서 쓴다(oci-ko 기준):

```bash
docker run -d --name ms-sqld-e2e -p 127.0.0.1:8082:8082 \
  -e SQLD_NODE=primary -e SQLD_HTTP_LISTEN_ADDR=0.0.0.0:8082 \
  -v sqld-e2e:/var/lib/sqld ghcr.io/tursodatabase/libsql-server:latest
# --network host 로 띄우면 gRPC 5001 이 운영 sqld 와 충돌한다. 브리지로 둘 것.

printf 'TURSO_DATABASE_URL=http://127.0.0.1:8082\nTURSO_AUTH_TOKEN=\n' > ~/.config/turso.env
grep -E '^S3_(ENDPOINT|REGION|BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY)=' \
  ~/memory-fork/MemoryStack/.env > ~/.config/oci-s3.env   # 끝나면 지울 것

export TDAI_METADATA_LIBSQL_URL=http://127.0.0.1:8082 TDAI_METADATA_LIBSQL_AUTH_TOKEN=
export TDAI_STORE_LIBSQL_URL=http://127.0.0.1:8082 TDAI_STORE_LIBSQL_AUTH_TOKEN=
export LLM_BASE_URL=... LLM_API_KEY=...        # MemoryStack/.env 의 PROXY_UPSTREAM_*

npx tsx src/core/store/__libsql-store.e2e.ts          # 메모리 스토어 7
npx tsx src/core/skill/__libsql-skill-store.e2e.ts    # 스킬 스토어 10
npx tsx src/core/skill/__skill-gateway.e2e.ts         # 스킬 HTTP 5
npx tsx src/core/storage/__s3-backend.itest.ts        # S3 백엔드 16 (버킷의 itest/ 프리픽스만 씀)
```

`__` 접두사라 vitest include 에 안 걸린다 — 위처럼 직접 실행해야 한다.
`npm install` 이 `edgesOut` 널참조로 죽으면 npm 10 의 peer 해석 버그다.
`--legacy-peer-deps` 를 붙인다.

하나라도 깨지면 그 드롭은 **이식이 깨진 것**이지 충돌 해소 실패가 아니다.
docs/09·11 의 함정(트랜잭션 핸들, WHERE 없는 DELETE)을 다시 읽을 것.

### 충돌 개수를 일정 산정에 쓰지 말 것

2026-09-11 병합에서 배운 것. `git merge-tree` 로 미리 잰 충돌은 7파일 · 16곳 ·
193줄이었고 그 예측은 정확했다. **그런데 실제 작업의 대부분은 충돌이 아니라
충돌 없이 자동 병합된 파일에서 나왔다.**

| 조용히 깨진 것 | 무엇이 잡았나 |
|---|---|
| `libsql-skill-store.ts` 임포트 — upstream 이 `store/sqlite.ts` 를 디렉터리로 쪼개고 `buildFtsQuery`/`tokenizeForFts` 를 `tokenize.ts` 로 옮김 | `npx tsdown` (빌드 실패) |
| `LibsqlMetadataStore` 에 `InstanceUpstreamConfig` 4메서드 누락 | 계약 테스트 10건 실패 |
| `StoreCapabilities.profileRows` 가 required 로 승격 | 타입체크 기준선 비교 |
| `listAgentFixedAssets` 의 `assetTypes` 필터를 무시 | **아무것도 못 잡았다.** 선택 인자라 타입에러도 없고 계약 테스트도 없다. 인터페이스 diff 를 눈으로 읽어서 발견 |

마지막 줄이 중요하다. 병합 후에는 **세 인터페이스(`IMemoryStore`,
`IMetadataStore`, `IStorageBackend`)의 diff 를 직접 읽는다.** 새로 생긴 멤버가
optional 이면 도구가 알려주지 않는다.

```bash
git diff <이전미러>..upstream/feat/server_team -- \
  MemoryCore/src/core/store/types.ts \
  MemoryCore/src/metadata/store/interface.ts \
  MemoryCore/src/core/storage/types.ts
```

upstream 이 세 seam 에 대한 계약 하네스(`__contract__/*.contract.ts`, 796줄)를
넣었다. 우리 구현을 거기에 꽂으면 이 수작업이 줄어든다 — 아직 안 했다.

## 라이선스

MIT (원본 유지). 이 포크의 추가분도 MIT.
