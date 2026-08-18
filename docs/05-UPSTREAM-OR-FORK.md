# ⑥ 업스트림 PR 인가, 포크인가

판정: **포크. 단, 포크를 싸게 만드는 협상 하나는 업스트림에 던질 만하다.**

---

## 0. 먼저 — 네 설계의 대부분은 PR 할 게 없다

`03-CENTRALIZATION.md` 의 Gateway 중앙화안은 **코드 변경이 0** 이다. 설정이다.
따라서 "PR 이냐 포크냐"는 오직 **libSQL 백엔드 부분**에만 걸리는 질문이다.

```
Gateway 중앙화        → PR 대상 아님 (제품을 설계대로 쓰는 것)
agentId 함정 문서화    → PR 가능 (문서)
LibsqlMemoryStore     → 여기가 진짜 질문
LibsqlMetadataStore   → 여기가 진짜 질문
```

---

## 1. 거버넌스 실측 (2026-08-19 기준)

### PR 통계

| 상태 | 수 |
|---|---|
| open | **483** |
| closed (unmerged) | 230 |
| merged | **56** |

- 전체 머지율 **56 / 769 ≈ 7.3%**
- 처리된 것만 봐도 **56 / 286 ≈ 19.6%**
- 그리고 merged 56건 중 상당수가 `Yuntong8888 <ellytan@tencent.com>` 의
  **README_CN.md 오타 수정**이다 (내부 인원).

### 커밋 히스토리 모양

```
97f9465  kentyhuang@tencent.com   docs: update README agent icons order...
29d609a  chrishuan@tencent.com    feat: release v2.0.1-beta.2
d0588e2  chrishuan@tencent.com    Merge remote-tracking branch 'github/feat/server_team'
ce93615  chrishuan@tencent.com    内部更新package.json
0aff21a  chrishuan@tencent.com    feat: release v2.0.0
```

**코드는 스쿼시된 릴리스 드롭으로 들어온다.** 즉 이 레포는 내부 모노레포의
**단방향 export** 이고, 공개 PR 은 그 옆에 붙은 별도 투입구다.

### 내부 리뷰 게이트

PR #1011 (`feat(memory-core): implement GitStorageBackend`, +2904/-130) 에 달린
유일한 코멘트:

> *"Thank you so much for your attention and contribution!
> **We will arrange an internal review** for this PR shortly,
> and all feedback will be shared right here."*

리뷰 0건, 4일째 open.

### 공개 레포가 자기 자신과 어긋나 있다

| 문서/설정이 말하는 것 | 실제 |
|---|---|
| `CONTRIBUTING.md`: `git clone .../Tencent/TencentDB-Agent-Memory` | 레포는 `TencentCloud/...` |
| `CONTRIBUTING.md`: PR 대상은 `develop_server_team` 또는 `master` | 브랜치는 `main`, `feat/server`, `feat/server_team` **뿐** |
| `CONTRIBUTING.md`: *"run the relevant tests — `npm test`"* | `*.test.ts` **0개**. `vitest run` 이 0개 파일에 돈다 |
| `package.json`: `test:oss` → `vitest.oss.config.ts` | 파일 **없음** |
| `package.json`: `test:standalone:*` → `__tests__/standalone/*.sh` | 디렉터리 **없음** |
| CI `pr-ci.yml`: `on: pull_request: branches: [main]` | 기본 브랜치는 `feat/server_team` → **기본 브랜치 PR 에 CI 가 안 돈다** |
| CI job 번호: 1, 2, **5, 6, 7** | 3·4번(lint/test 추정)이 공개 워크플로에서 삭제됨 |

> 참고: 이 어긋남은 나만 본 게 아니다. #1053/#1054/#1055
> (`docs: fix stale branch names in CONTRIBUTING`) 가 이미 올라와 있고, 역시 open 이다.

### 설계 컨텍스트가 비공개다

코드 주석이 참조하는 설계 문서 **17종이 전부 공개 트리에 없다**:

```
docs/design/2026-06-17-skill-redesign-v2.md          ×8
docs/l0l3-tenant-isolation-design.md                 ×6
docs/design/2026-07-21-skill-worker-crash-recovery.md ×5
docs/design/vdb-knowledge-collection.md              ×3
SKILL_ENGINEERING_DESIGN §13.3                       ×2
team-memory-control/docs/architecture/08-metadata-migration-...md
...
```

**저장 계층이 왜 이 모양인지를 설명하는 문서가 전부 사내에 있다.**
저장 계층 PR 을 쓰면서 "왜 이렇게 안 했냐"는 리뷰에 답할 근거를 네가 갖지 못한다.

---

## 2. 그런데 외부 코드가 아예 안 머지되는 건 아니다

공정하게 적자면, 실제로 머지된 외부 기능 PR 이 있다:

```
#577  Rememorio          +759/-8   19 files  feat(gateway): Offload V2 result ref recovery
#228  jackson-jia-914    +514/-2   13 files  feat(llm): multi-provider disableThinking
#151  PorunC             +528/-476  9 files  feat(hermes): Windows native setup
#227  RerankerGuo         +65/-55   2 files  fix(gateway): route local L2 timers
#150  MicroGery          +194/-2    3 files  fix(offload): local-llm apiKey
```

**공통점: 전부 가장자리의 additive 한 기능이다.** 게이트웨이 핸들러, LLM 프로바이더
전략, 윈도우 설치. **저장 계층 코어를 건드린 외부 머지는 0건이다.**

그리고 반대 사례도 크다 — RerankerGuo 는 잘 쓰인 fix 10건을 올렸고
**2026-08-12 에 전부 unmerged 로 일괄 클로즈**됐다.

---

## 3. 저장 백엔드 PR 이 특히 안 될 이유 (기술이 아니라 사업)

```
storeBackend: "sqlite" | "tcvdb"
                         └── 텐센트 클라우드 벡터DB = 이 회사의 유료 제품
```

이 프로젝트에서 **"원격 저장 백엔드"의 자리는 이미 TCVDB 가 점유하고 있고,
그게 수익 경로다.** `LibsqlMemoryStore` 는 기능적으로 그 자리의 **직접 대체재**다.

기술적 반대가 아니라 이해관계다. 그리고 이런 PR 의 운명을 가장 잘 예측하는 변수다.

> 상대적으로 `IMetadataStore` 쪽은 덜하다 — MongoDB 라는 중립 3rd-party 선례가 이미
> 있고, `MetadataBackend = "sqlite" | "mongodb" | "mysql"` 로 **3번째 슬롯이 이미
> 예약되어 있다** (`metadata/store/interface.ts:201`, mysql 은 미구현).
> 그래도 483건 대기열 앞에서는 큰 의미가 없다.

---

## 4. 좋은 소식 — 이 포크는 유지비가 싸다

포크의 진짜 비용은 rebase 다. 그런데 이 코드베이스는 **신규 파일 추가 위주**로
백엔드를 붙일 수 있게 되어 있다.

### 추가할 파일 (업스트림과 절대 충돌 안 함)
```
MemoryCore/src/core/store/libsql.ts              신규 ~2,000–3,000 LOC
MemoryCore/src/metadata/store/libsql-adapter.ts  신규 ~1,800 LOC 대응
MemoryCore/src/core/skill/libsql-skill-store.ts  신규 (선택, 후순위)
```

### 수정할 파일 (충돌 지점 — 전부 작다)
```
config.ts:183              type StoreBackend = "sqlite" | "tcvdb" | "libsql"   ← 1줄
config.ts:480              파싱 분기                                            ← 2줄
core/store/factory.ts      switch 에 case 1개                                   ← ~30줄
core/store/store-pool.ts   StoreMode 확장 + createLibsqlStore()                 ← ~40줄
metadata/store/interface.ts:201  MetadataBackend 에 "libsql"                    ← 1줄
metadata/store/factory.ts  case 1개 (mongodb 처럼 dynamic import)               ← ~20줄
```

**수정 지점 6곳, 총 100줄 미만.** 나머지는 전부 add-only.
게다가 `mongodb-adapter` 가 `await import("./mongodb-adapter.js")` 로 **동적 로드**되는
패턴이라(`metadata/store/factory.ts:153`), 같은 모양을 따르면 번들 영향도 없다.

업스트림이 스쿼시 릴리스를 떨궈도 이 6개 훅에서만 충돌한다. **연 몇 번 30분.**

---

## 5. 그래서 — 업스트림에 던질 가치가 있는 딱 하나

PR 이 아니라 **Issue** 다. 그리고 구현이 아니라 **심(seam)** 을 협상한다.

> **"storeBackend 를 닫힌 유니온 대신 등록 가능한 레지스트리로 열어줄 수 있나?"**
>
> 지금: `type StoreBackend = "sqlite" | "tcvdb"` + factory/store-pool 하드코딩 switch
> 제안: `registerStoreBackend(name, factoryFn)` — 50줄 내외의 변경
>
> 근거로 붙일 것: `IMemoryStore` 는 이미 `MaybePromise` 계약이고 TCVDB 라는 원격
> 구현 선례가 있다. 즉 다중 백엔드는 이미 설계 의도다. 유니온만 닫혀 있을 뿐이다.
> `IStorageBackend` 쪽에도 같은 수요가 이미 올라와 있다 (#1011 GitStorageBackend).

**이게 머지되면 네 3,000 LOC 포크가 플러그인이 된다.**
안 되면 10분 손해다. 어느 쪽이든 손실이 없는 유일한 카드다.

동시에 던져도 좋은 것 (전부 tiny, 내부 컨텍스트 불필요):

- **문서**: L2/L3 정체성이 `(teamId, agentId)` 라는 사실이 `INSTALL.md` 어디에도 없다.
  멀티머신으로 붙이는 사람은 100% 밟는다. (`core/profile/profile-sync.ts:20`)
- **문서/설정**: `npm test` 가 0개 파일에 돌고 `vitest.oss.config.ts` 가 없는데
  `CONTRIBUTING.md` 는 "run the relevant tests" 라고 한다.

단, **483건 대기열 + 7% 머지율**이라는 걸 알고 던져라.
**머지되는 것에서 가치를 얻지 말고, 던지는 행위 자체가 공짜인 것만 던져라.**

---

## 6. 결론

```
┌─ Gateway 중앙화        → PR/포크 무관. 오늘 설정으로 끝.
│
├─ libSQL 백엔드         → 포크.
│    · 저장 코어 외부 머지 선례 0건
│    · TCVDB 와 직접 경쟁 (사업적 이해충돌)
│    · 설계 문서 17종이 비공개 → 리뷰에 답할 근거가 없다
│    · 483 open / 7% 머지율
│    · 반면 포크 유지비는 수정 6곳·100줄 미만으로 낮다
│
└─ 업스트림에 던질 것    → Issue 1개 (백엔드 레지스트리) + 문서 PR 2개
     머지되면 포크가 플러그인이 되고, 안 되면 10분 손해.
```

**포크 이름은 upstream 과 겹치지 않게, MIT 라이선스 고지는 유지.**
`sdk/` 와 `MemoryProxy` 는 손대지 말고 업스트림을 그대로 쓰는 게
rebase 표면을 최소로 유지하는 길이다.
