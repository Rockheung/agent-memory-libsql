# TencentDB Agent Memory — 코드레벨 분석

`TencentCloud/TencentDB-Agent-Memory` @ `97f9465` (2026-08-15) 를 클론해
저장 계층을 코드 레벨에서 읽고 정리한 문서.

**출발 질문:** 여러 머신(Mac / GPU-1 / GPU-2 / Pi)이 하나의 에이전트 기억을
공유하게 하려면 어디를 건드려야 하는가. Turso 가 그 자리를 채울 수 있는가.

| 문서 | 내용 |
|---|---|
| [00-OVERVIEW.md](00-OVERVIEW.md) | 4개 컴포넌트 구조, 4계층 메모리 모델, 저장 계층 4개 심 |
| [01-STORAGE-ARCHITECTURE.md](01-STORAGE-ARCHITECTURE.md) | 심별 코드레벨 해부 — 인터페이스 / DDL / 검색 경로 / 결합 지점 |
| [02-TURSO-FEASIBILITY.md](02-TURSO-FEASIBILITY.md) | Turso·libSQL 이식 판정, 3개 경로 비교, D1 검토 |
| [03-CENTRALIZATION.md](03-CENTRALIZATION.md) | 실제 멀티머신 설계안, 안 되는 조합, 30분 검증 절차 |
| [04-MARKDOWN-PLACEMENT.md](04-MARKDOWN-PLACEMENT.md) | L2/L3 마크다운을 어디에 둘 것인가 — 3개 안 비교 + `agentId` 함정 |
| [05-UPSTREAM-OR-FORK.md](05-UPSTREAM-OR-FORK.md) | 업스트림 PR vs 포크 — 거버넌스 실측 데이터 기반 판정 |
| [ROADMAP.md](ROADMAP.md) | **작업 계획** — M0(코드 0) ~ M5 + 업스트림 트랙 |
| [06-M0-RESULT.md](06-M0-RESULT.md) | **M0 실측 결과** — Gateway 중앙화 검증 통과, 발견 9건 |

---

## 세 줄 요약

1. **저장 계층은 이미 추상화돼 있고, 원격/비동기 백엔드가 1급 시민이다.**
   `IMemoryStore` / `IMetadataStore` 는 `MaybePromise` 계약이고 호출부가 전부 `await` 한다.
   TCVDB(HTTP)와 MongoDB 라는 원격 구현 선례가 살아 있다.

2. **그래도 Turso 는 "connection string 교체"가 아니다.**
   `node:sqlite` 드라이버 + `vec0` 가상 테이블 + 후보 1건당 SQL 1회를 치는 KNN 루프
   (`sqlite.ts:1513`)가 걸린다. 제대로 하려면 2,000~3,000 LOC 짜리 새 스토어 구현이다.

3. **그런데 원하는 중앙화는 Turso 없이 이미 된다.**
   OpenClaw 플러그인에 `mode: "remote"` 가 있고 (`MemoryCore/index.ts:64`),
   순수 HTTP 씬 클라이언트가 이미 구현돼 있다. 중앙에 놓을 것은 DB 가 아니라
   **memory-core Gateway** 다. L2/L3 는 DB 가 아니라 마크다운 파일이라
   DB 만 중앙화해서는 어차피 안 풀린다.
