# ROADMAP

근거: [`./`](README.md) 6편. 판정 요약은 [`README.md`](README.md).

원칙 하나: **각 마일스톤은 독립적으로 가치가 있고, 어디서 멈춰도 시스템이 돈다.**
M0 에서 멈추면 목표(멀티머신 기억 공유)는 이미 100% 달성이다. M1 이후는 백업 자동화다.

---

## M0 — Gateway 중앙화 검증 · **코드 0줄**

> 이걸 먼저 하는 이유: 성공하면 M1 이후의 **범위가 줄어든다.**
> Turso 가 풀려던 문제의 대부분이 여기서 사라지고 "백업 자동화"만 남는다.

### 목표

한 대에 memory-core 를 띄우고, 두 대 이상의 클라이언트가 **같은 기억**을 보는지 확인.

### 절차

```bash
cd deploy/global-images
cp .env.example .env && $EDITOR .env      # MEMORY_LLM_* 만 채우면 M0 는 충분
./verify.sh --skip-llm                    # 드라이런: docker/포트/필수값 점검
./start-memory-core.sh                    # memory-core 단독 기동 (:8420)
```

> `start-all.sh` 는 `PROXY_UPSTREAM_*` 까지 전부 요구한다.
> M0 에서는 memory-core 만 있으면 되므로 `start-memory-core.sh` 를 직접 부른다.

### 체크리스트

- [ ] **C0** `verify.sh --skip-llm` 통과
- [ ] **C1** `GET :8420/v3/meta/auth/verify` 응답. `.admin-key` 파일 생성 확인
- [ ] **C2** `POST /v3/conversation/add` → `POST /v3/atomic/search` 로 되돌아오는가
- [ ] **C3** Mac OpenClaw 를 `mode: "remote"` 로 붙인다 (아래 설정)
- [ ] **C4** **두 번째 머신**(Pi/GPU)에서 같은 설정으로 붙여 C2 의 결과가 보이는가
- [ ] **C5** `embedding.provider` 를 실제 값으로 켜고 벡터 검색이 도는가
      (기본값 `"none"` → BM25/FTS5 만 돈다. `03-CENTRALIZATION.md` §주의점)
- [ ] **C6** L2/L3 가 생성되는가 — `docker exec` 로 `persona.md` / `scene_blocks/*.md` 확인
- [ ] **C7** 두 머신의 L2/L3 가 **하나로 합쳐지는가** (`agentId` 를 같게 줬을 때)

### 클라이언트 설정 (모든 머신 동일)

```jsonc
{
  "mode": "remote",
  "server": {
    "url": "http://<gateway-host>:8420",
    "apiKey": "<MEMORY_CORE_GATEWAY_API_KEY 또는 local>",
    "instanceId": "default",
    "teamId": "rock",
    "agentId": "rock-agent",   // ⚠️ 머신별로 다르게 주면 L2/L3 페르소나가 쪼개진다
    "userId": "rock"
  },
  "recall": { "maxResults": 5, "includePersona": true }
}
```

> `agentId` 함정 근거: `MemoryCore/src/core/profile/profile-sync.ts:20` —
> L2/L3 정체성은 `(teamId, agentId)` 쌍이고 userId/sessionId/taskId 를 의도적으로 무시한다.
> 상세: `04-MARKDOWN-PLACEMENT.md` §4

### 배포 시 확인할 것

- [ ] `MEMORY_CORE_GATEWAY_API_KEY` — 기동 스크립트 기본값이 **빈 문자열**이다
      (`deploy/global-images/start-memory-core.sh:24-33`).
      LAN 밖으로 낼 거면 NPM 앞단에서 반드시 인증을 건다.
- [ ] `tdai-memory-core-data` 볼륨 스냅샷 백업 잡 (M0 단계의 백업 = 이것 하나)
- [ ] ARM64 이미지 확인 — oci-ko / Pi 에 올릴 경우

### 산출물

`06-M0-RESULT.md` — 무엇이 됐고 무엇이 안 됐는지. **이걸로 M1 범위를 재조정한다.**

---

## M1 — 계약 테스트 하네스 복원 · 선행조건

> upstream OSS 릴리스에는 `*.test.ts` 가 **0개**다.
> `metadata-store.contract.ts` (854 LOC) 본체는 남아있고 **호출부만 제거**됐다.
> 백엔드를 새로 쓰기 전에 이걸 먼저 세운다. 안 그러면 검증 수단이 없다.

- [ ] `MemoryCore/src/metadata/store/sqlite-adapter.test.ts` 작성
      → `runMetadataStoreContract("sqlite", ...)` 호출, **기존 SQLite 백엔드로 green** 만들기
- [ ] `vitest.oss.config.ts` 가 없어서 `npm run test:oss` 가 깨진다 → 추가하거나 스크립트 정리
- [ ] `IMemoryStore` 는 계약 테스트가 **없다.** `sqlite.ts` 동작을 기준으로 최소 스위트 작성
      (L0/L1 upsert→search→delete, isolation 필터, FTS, 페이지네이션)

**여기서 SQLite 가 green 이 안 되면 그 자체가 발견이다.** 진행 전에 원인을 적는다.

---

## M2 — `LibsqlMetadataStore`

> 여기부터 시작하는 이유: 계약 테스트가 **이미 존재**하고, SQL 실행이
> `get / all / run / tx` **4개 헬퍼**로 수렴한다 (`sqlite-adapter.ts:408-435`).
> 즉 가장 싸고 가장 검증 가능한 조각이다.

- [ ] `metadata/store/libsql-adapter.ts` 신규 — `@libsql/client` 비동기
- [ ] `MetadataBackend` 에 `"libsql"` (`interface.ts:201` — `"mysql"` 슬롯이 이미 예약돼 있다)
- [ ] `metadata/store/factory.ts` 에 `case` 추가. **mongodb 처럼 `await import()`** 로 동적 로드
- [ ] `runMetadataStoreContract("libsql", ...)` 통과
- [ ] ⚠️ **함정**: `sqlite-adapter.ts:76` 이 UNIQUE 위반을 **에러 메시지 정규식**으로 판정한다.
      ```
      /UNIQUE constraint failed: meta_\w+\.(user_id|team_id|...)/
      ```
      드라이버가 바뀌면 조용히 깨진다. 계약 테스트가 잡아야 한다.
- [ ] 부분 유니크 인덱스(`WHERE user_type = 'system_admin'`) / `PRAGMA foreign_keys` 동작 확인

---

## M3 — `LibsqlMemoryStore`

> 규모 2,000–3,000 LOC. `tcvdb.ts` (2,503 LOC) 가 참고 구현이다.

- [ ] **선결**: Turso 인스턴스에서 `sqlite-vec` 가용 여부·버전 **실측**.
      안 되면 네이티브 `F32_BLOB` 확정 — **이쪽이 더 낫다.**
- [ ] `core/store/libsql.ts` 신규 — 전 메서드 `async` (인터페이스가 `MaybePromise` 라 합법)
- [ ] 스키마: `l1_records` / `l0_conversations` 에 `embedding F32_BLOB(N)` 컬럼 +
      `CREATE INDEX ... libsql_vector_idx(embedding)`
- [ ] **`searchL1Vector` / `searchL0Vector` 를 JOIN 1회로 재작성.**
      현재 구현은 후보 1건당 `stmtGetMeta.get()` 1회 (`sqlite.ts:1513`) — 원격에선 못 쓴다.
      동시에 격리 필터를 SQL 로 내린다 (현재는 5배 over-fetch 후 JS 필터).
- [ ] FTS5 (`l1_fts` / `l0_fts`) — libSQL 도 SQLite 기반이라 그대로 간다. 확인만.
- [ ] 백엔드 스위치: `config.ts:183`, `config.ts:480`, `core/store/factory.ts`, `store-pool.ts`
- [ ] Skill 은 **후순위**. `getRawDb()` 가 없으면 `tdai-core.ts:867` 이 경고 후 자동 스킵한다.

---

## M4 — L2/L3 마크다운을 DB 로 (`pullProfiles` / `syncProfiles`)

> SQLite 스토어는 이 5개 optional 메서드를 **구현하지 않는다.** TCVDB 는 한다.
> M3 를 하면 같이 구현하는 게 맞다 — 그러면 오브젝트 스토리지가 **아예 필요 없어진다.**
> 근거: `04-MARKDOWN-PLACEMENT.md` §안 C

- [ ] `profiles` 테이블 (id / type / filename / content / content_md5 / team_id / agent_id / version)
- [ ] `syncProfiles` 에 `baselineVersion` 낙관적 락 (`UPDATE ... WHERE version = ?`)
- [ ] `pullProfiles` / `queryProfilesByIds` / `countProfiles` / `deleteProfiles`
- [ ] 트레이드오프 확인: 로컬 마크다운은 캐시가 되고 다음 pull 이 덮어쓴다.
      직접 편집/git 관리를 원하면 M4 를 건너뛰고 M0 의 로컬 FS 유지가 낫다.

---

## M5 — (선택) Skill store

- [ ] `core/skill/libsql-skill-store.ts` — `tcvdb-skill-store.ts` 가 참고 구현
- [ ] `ISkillStore` 를 만족시키고 `store-pool.getSkillStore()` 에 연결

---

## 업스트림 트랙 (U) — M0/M1 과 병렬, 서로 블로킹 아님

> upstream 실측: open **483** / closed-unmerged **230** / merged **56** (머지율 7.3%).
> **머지되는 것에서 가치를 얻지 말고, 던지는 행위 자체가 공짜인 것만 던진다.**
> 근거: `05-UPSTREAM-OR-FORK.md`

- [ ] **U1 (Issue, 최우선)** — "storeBackend 를 닫힌 유니온 대신 등록 가능한 레지스트리로
      열어줄 수 있나?" 머지되면 M2/M3 포크가 **플러그인**이 된다. 안 되면 10분 손해.
      근거로 붙일 것: `IMemoryStore` 는 이미 `MaybePromise` 계약 + TCVDB 원격 선례,
      `IStorageBackend` 쪽에도 같은 수요가 이미 있다 (upstream PR #1011 GitStorageBackend).
- [ ] **U2 (docs PR)** — L2/L3 정체성이 `(teamId, agentId)` 라는 사실이 `INSTALL.md` 에 없다.
      멀티머신으로 붙이는 사람은 100% 밟는다. `pr/docs-l2l3-identity` 브랜치.
- [ ] **U3 (docs PR)** — `npm test` 가 0개 파일에 돌고 `vitest.oss.config.ts` 가 없는데
      `CONTRIBUTING.md` 는 "run the relevant tests" 라고 한다.
      ※ 스테일 브랜치명 건은 이미 upstream #1053~1055 가 올려둠 — 중복 금지, 확인 후 진행.

**U 브랜치는 반드시 `feat/server_team` 에서 분기한다.** `rock/main` 커밋이 섞이면 안 된다.

---

## 현재 상태

| | |
|---|---|
| 포크 | `Rockheung/agent-memory-libsql` ← `TencentCloud/TencentDB-Agent-Memory` |
| 브랜치 | `rock/main` (작업), `feat/server_team` (upstream 미러) |
| 완료 | 코드레벨 분석 `docs/` 6편 |
| **다음** | **M0-C0 ~ C2** — 게이트웨이 띄우고 왕복 확인 |
