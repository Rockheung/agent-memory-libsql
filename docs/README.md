# TencentDB Agent Memory — 코드레벨 분석

`TencentCloud/TencentDB-Agent-Memory` @ `97f9465` (2026-08-15) 를 클론해
저장 계층을 코드 레벨에서 읽고 정리한 문서.

**출발 질문:** 여러 머신(Mac / GPU-1 / GPU-2 / Pi)이 하나의 에이전트 기억을
공유하게 하려면 어디를 건드려야 하는가. Turso 가 그 자리를 채울 수 있는가.

**결론 (2026-08-25):** 공유는 Turso 없이 설정만으로 됐다(M0). 그래서 Turso 로 간
진짜 이유는 공유가 아니라 **DB 를 직접 운영하지 않기 위해서**다. 이식은 끝났고
상태는 전부 Turso + Oracle Object Storage 에 있다 — 현황은 [ROADMAP.md](ROADMAP.md).

| 문서 | 내용 |
|---|---|
| [00-OVERVIEW.md](00-OVERVIEW.md) | 4개 컴포넌트 구조, 4계층 메모리 모델, 저장 계층 4개 심 |
| [01-STORAGE-ARCHITECTURE.md](01-STORAGE-ARCHITECTURE.md) | 심별 코드레벨 해부 — 인터페이스 / DDL / 검색 경로 / 결합 지점 |
| [02-TURSO-FEASIBILITY.md](02-TURSO-FEASIBILITY.md) | Turso·libSQL 이식 판정, 3개 경로 비교, D1 검토 |
| [03-CENTRALIZATION.md](03-CENTRALIZATION.md) | 실제 멀티머신 설계안, 안 되는 조합, 30분 검증 절차 |
| [04-MARKDOWN-PLACEMENT.md](04-MARKDOWN-PLACEMENT.md) | L2/L3 마크다운을 어디에 둘 것인가 — 3개 안 비교 + `agentId` 함정 |
| [05-UPSTREAM-OR-FORK.md](05-UPSTREAM-OR-FORK.md) | 업스트림 PR vs 포크 — 거버넌스 실측 데이터 기반 판정 |
| [06-M0-RESULT.md](06-M0-RESULT.md) | **M0 실측 결과** — Gateway 중앙화 검증 통과, 발견 F1–F12 |
| [07-TURSO-SPIKE.md](07-TURSO-SPIKE.md) | 착수 전 가정 5개 실측 — sync 드라이버 기각, 네이티브 벡터 확정 |
| [08-S3-STORAGE-BACKEND.md](08-S3-STORAGE-BACKEND.md) | `IStorageBackend` → 오브젝트 스토리지. 세그먼트 append, Oracle 함정 |
| [09-LIBSQL-METADATA-STORE.md](09-LIBSQL-METADATA-STORE.md) | `IMetadataStore` → Turso. 계약 96/96, 트랜잭션 핸들 함정 |
| [10-MANAGED-INTEGRATION.md](10-MANAGED-INTEGRATION.md) | 게이트웨이 배선 — 응답 200 인데 아무것도 안 쌓이던 두 건 |
| [11-LIBSQL-MEMORY-STORE.md](11-LIBSQL-MEMORY-STORE.md) | `IMemoryStore` → Turso. KNN 재작성, WHERE 없는 DELETE 가 인덱스를 깬다 |
| [12-M2-DEPLOYMENT.md](12-M2-DEPLOYMENT.md) | oci-ko 상시 배포 — 컨테이너·systemd·방화벽·NPM |
| [13-ARCHITECTURE.md](13-ARCHITECTURE.md) | **현재 아키텍처** — 지금 상태는 여기만 본다 |
| [ROADMAP.md](ROADMAP.md) | **현황** — M0~M7 완료, 남은 운영 항목 |

---

## 세 줄 요약

1. **저장 계층은 이미 추상화돼 있고, 원격/비동기 백엔드가 1급 시민이다.**
   `IMemoryStore` / `IMetadataStore` 는 `MaybePromise` 계약이고 호출부가 전부 `await` 한다.
   TCVDB(HTTP)와 MongoDB 라는 원격 구현 선례가 살아 있다.

2. **그래도 Turso 는 "connection string 교체"가 아니다.**
   `node:sqlite` 드라이버 + `vec0` 가상 테이블 + 후보 1건당 SQL 1회를 치는 KNN 루프
   (`sqlite.ts:1513`)가 걸린다. 제대로 하려면 2,000~3,000 LOC 짜리 새 스토어 구현이다.

3. **그런데 원하는 중앙화는 Turso 없이 이미 된다.**
   중앙에 놓을 것은 DB 가 아니라 **memory-core Gateway** 다. 클라이언트는
   **MemoryProxy(:8096)** 로 붙는다 — Claude Code 포함 8종이 전부 이 경로다.
   (OpenClaw 플러그인의 `mode: "remote"` 는 OpenClaw 전용 *추가* 옵션이다.) L2/L3 는 DB 가 아니라 마크다운 파일이라
   DB 만 중앙화해서는 어차피 안 풀린다.
