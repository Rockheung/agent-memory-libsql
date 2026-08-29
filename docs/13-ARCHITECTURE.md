# 현재 아키텍처

> 이 문서만 **현재 상태**를 기술한다. `00`~`12` 는 각 시점의 분석·판정 기록이라
> 지금과 다를 수 있다. 어긋나면 이 문서가 맞다.
>
> 최종 갱신: 2026-08-30

## 한 줄

에이전트 기억을 **oci-ko 한 대에서 처리**하고, **상태는 전부 관리형 저장소**에 둔다.
컨테이너를 전부 날려도 잃을 것이 없다.

---

## 1. 물리 배치

```
집 192.168.88.0/24                    oci-ko 10.77.0.4 (wg0) / 공인 IP
┌──────────────────────┐             ┌────────────────────────────────┐
│ NPM        .203      │   wg0       │ edge     :8090  헤더 주입       │
│  HTTPS 종단           ├────────────►│ proxy    :8096  세션·기억 주입  │
│  *.h.rockheung.xyz   │             │ core     :8420  L0~L3 추출      │
│  LE 와일드카드 cert    │             │ cliproxy :8317  모델 라우팅     │
└──────────────────────┘             │ ollama  :11434  bge-m3 상주     │
                                     └────────────────────────────────┘
GitHub                                            │
 CI(ubuntu-24.04-arm) → ghcr ────pull────────────►│
                                                  │
                                sqld(로컬) ────────┴──────── OCI Object Storage
```

집에 남은 역할은 **HTTPS 종단 하나뿐**이다. 오버레이망(`10.77.0.4`)으로 직접
붙으면 집 없이도 완전히 동작한다.

`cliproxy` 는 이 스택보다 먼저 있던 별개 프로세스다(systemd 아님, 수동 기동).
`10.77.0.4` 에만 바인딩돼 있어서 **컨테이너 셋을 전부 `network_mode: host` 로**
돌린다 — 브리지에 두면 `EHOSTUNREACH` 로 추출이 조용히 0건이 된다.

`ollama` 도 compose 밖의 systemd 서비스다(`127.0.0.1:11434`).

---

## 1-2. 왜 Turso 를 떠났나

2026-08-28, Turso 무료 플랜의 **읽기 쿼터가 소진돼 `SELECT 1` 까지 BLOCKED** 됐다.
회상·인증이 전부 500 이 되어 프록시 경유 채팅이 죽었다(쓰기는 살아있었다).

원인은 백업이었다. 임베디드 리플리카 동기화가 DB 파일 전량(472MB)을 매일 읽는데,
**그중 96%가 고아 인덱스가 남긴 빈 페이지**였다. 6회에 2.8GB.

`ghcr.io/tursodatabase/libsql-server` 를 직접 띄워 옮겼다. 프로토콜이 같아
**이식 코드는 한 줄도 고치지 않았다** — `TURSO_URL` 만 바꿨다. 사전 검증에서
`F32_BLOB` · `libsql_vector_idx` · `vector_top_k` · `vector_distance_cos` · FTS5 ·
`bm25()` · 트랜잭션이 전부 통과했다(sqlite 3.47.0).

2026-08-30, DB 를 **논리 재구축**했다. 고아 DROP 이후 freelist 헤더가 어긋나
`integrity_check` 가 경고를 냈고 파일이 472MB(실사용 18MB)였다. `VACUUM` 은
`libsql_vector_meta_shadow` 를 중복시켜 못 쓴다(실측). 그래서 스키마와 행만
새 파일에 심었다 — 테이블 → 데이터 → 인덱스 → FTS 순서.

```
472MB → 18MB · integrity ok · freelist 0
백업   22.5초 58MB → 1.35초 6.1MB
```

대가: **oci-ko 가 단일 장애점**이 됐다. 예전엔 Turso 와 oci-ko 가 서로 독립이었다.

---

## 2. 상태가 어디에 있나

| 무엇 | 어디 | 비고 |
|---|---|---|
| L0 원본 대화 · L1 원자기억 | **sqld** (자체 호스팅, named volume) | `F32_BLOB(1024)` 네이티브 벡터 + FTS5 |
| 메타(팀·에이전트·유저·태스크) | **sqld** | |
| 스킬 + 인덱스 | **sqld** | |
| L2 시나리오 · L3 페르소나 (마크다운) | **OCI Object Storage** | `prod/profiles/…` |
| 스킬 첨부 · JSONL | **OCI Object Storage** | `prod/skill_buffer/…` |
| 로컬 | `manifest.json` 207B · proxy 캐시 | 둘 다 재생성됨 |

**로컬 SQLite 파일도 도커 볼륨도 쓰지 않는다.** 새 호스트에서 `.env` 만 채우면
그대로 이어진다.

자격증명은 전부 런타임 `.env` 로만 들어간다 — 이미지에는 없다.

---

## 3. 기억 모델

```
L0 원본 대화
 ↓ LLM 추출        모든 대화가 기억이 되지는 않는다. 매번 거른다.
L1 원자 기억        "사용자는 oci-ko 를 상시 호스트로 정했다"
 ↓ LLM 묶기
L2 시나리오 블록     주제별 마크다운. heat(회상 적중 횟수)를 들고 있다.
 ↓ LLM 종합
L3 페르소나         사용자 서사 프로필 1장
```

**Skill** 은 계층이 아니라 옆가지다 — 재사용 가능한 기술 묶음이고 자체 벡터·FTS 를 갖는다.

추출은 응답 경로에 **없다.** 대화를 넣으면 즉시 반환하고 워커가 뒤에서 돈다.
각 단계는 커서를 들고 있어 새 입력이 없으면 건너뛴다.

### 격리축 — 이 비대칭이 설계의 핵심이다

```
L0 / L1     (team, user, agent, session, task)   5축
L2 / L3     (team, agent)                        2축  ← user·session·task 무시
```

여러 머신이 같은 `agent_id` 로 붙으면 **인격이 하나로 합쳐진다.** 멀티머신
공유가 코드 0줄로 됐던 이유이자, `agentId` 를 머신별로 다르게 주면 페르소나가
쪼개지는 함정이기도 하다.

나누고 싶다면 축을 고른다: `user_id` → L0/L1 만 분리(페르소나 공유),
`agent_id` → 완전 분리(페르소나도 각각), `task_id` → 프로젝트별 분리.

---

## 4. 요청 경로

### ① 기억이 붙는 채팅 (보편 경로)

```
임의 OpenAI 호환 클라이언트
  → https://cliproxy-memd.h.rockheung.xyz/v1
  → NPM → edge → proxy → cliproxy → 모델
                   └─ HTTP → core (기억 조회·기록)
```

edge 가 필요한 이유는 **대부분의 클라이언트가 커스텀 헤더를 못 보내기** 때문이다.
`x-team-id` / `x-agent-id` / `x-task-id` 를 nginx 가 대신 박는다. 클라이언트는
**base URL 만 바꾸면 된다.**

주의: `/v1/models` 만 edge 가 cliproxy 로 직통시킨다 → **cliproxy 키**가 필요하다
(메모리 키가 아니다).

### ② 기록 전용 (LLM 안 거침)

```
mem.py → https://memory.h.rockheung.xyz/v3/conversation/add
```

기억을 남기는 데 LLM 은 필요 없다 — 서버가 어차피 자기 모델로 L1 을 뽑는다.
`claude -p` 로 같은 일을 하면 시스템 프롬프트·도구 정의 때문에 호출당 2만 토큰이
넘는다(실측 $0.058). `mem` 은 클라이언트 토큰 0 이다.

### ③ Claude Code 훅 — 현재 비활성

`ClaudeCodeAdapter/memory_hook.py` 는 남아있지만 `~/.claude/settings.json` 에
등록하지 않았다. `only_entrypoints: ["sdk-cli"]` 로 **`claude -p` 에만** 붙일 수
있다(대화형은 `cli`, `-p` 는 `sdk-cli` — 실측 확인).

### 엔드포인트 정리

```
cliproxy-memd.h.rockheung.xyz/v1    기억 있음
cliproxy.h.rockheung.xyz/v1         기억 없음 (기존 경로)
memory.h.rockheung.xyz              게이트웨이 직접 (/v3/…)
```

---

## 5. 모델

| 용도 | 모델 | 위치 |
|---|---|---|
| L1/L2/L3 추출 | `gpt-5.6-sol-low` | cliproxy 경유 |
| 임베딩 | `bge-m3` 1024차원 | **oci-ko 로컬 ollama** |
| 클라이언트 | 고정 안 함 | cliproxy 50개 전부 통과 |

### 임베딩 설정의 근거

```
num_ctx 8192 + num_batch 8192      둘 다 필요하다
```

ollama 는 `-ub = min(num_batch, num_ctx)` 로 잡고, GPU 없는 박스의 기본
`num_ctx` 는 4096 이다. **`num_batch` 만 올리면 4096 에서 잘린다.**
`num_batch` 는 ollama Modelfile 공식 문서에 없는 비문서화 옵션이다.

`OLLAMA_KEEP_ALIVE=-1` 로 상주시킨다. 기본 5분 언로드는 재적재에 3초가 들고,
그 3초가 회상 예산을 넘겨 **에러 없이 기억만 사라지게** 만든다(실측 사고 1건).

실측 지연(2코어 ARM, 한국어):

```
  58토큰  0.38초   ← 질의는 여기. 온디맨드 경로
 550토큰  3.9초
2048토큰   23초
8192토큰  237초    ← O(n²). 백그라운드 경로라 감내
```

**주의**: ollama 의 `/api/embed` 는 `truncate` 기본값이 `true` 라 상한 초과분을
조용히 버린다. 감지하려면 `truncate:false` (단, core 는 OpenAI 포맷을 써서
이 옵션을 못 넘긴다). 긴 문서는 BAAI 가 **512 청킹**을 권장한다 — 통짜보다
3배 빠르고 검색 품질도 낫다. 현재 데이터가 상한에 안 닿아 미구현.

---

## 6. 배포

```
rock/main 푸시 → CI(arm64) → ghcr.io/rockheung/{memory-core-libsql,memory-proxy-auth}
                              태그: 커밋 SHA + latest
oci-ko: IMAGE_TAG 지정 → docker compose pull && up -d
```

**호스트에서 빌드하지 않는다.** 이미지 라벨에 revision 이 박혀 있어 배포본
커밋을 특정할 수 있고, 롤백은 `.env` 의 `IMAGE_TAG` 한 줄이다.

배포 호스트에 필요한 것은 `MemoryStack/` 과 `.env` 뿐 — 소스 트리는 불필요하다.

베이스 이미지(`agentmemory/*`)는 워크플로에서 **다이제스트로 고정**한다.
`latest` 를 물면 upstream 이 조용히 바뀌었을 때 같은 커밋에서 다른 이미지가 나온다.

---

## 7. 운영

```
systemd   memory-stack.service        컨테이너 3개
          memory-stack-backup.timer   매일 03:20 KST (+지터 20분), 14벌 보존
          ollama.service              KEEP_ALIVE=-1, NUM_PARALLEL=1
방화벽     8090/8420 → 홈랩 LAN + 오버레이만. 공인은 OCI 보안목록이 이중 차단
```

백업은 sqld 를 임베디드 리플리카로 당겨 gz, S3 는 원본 경로 그대로 미러한다.
`manifest.json` 에 `integrity_check`·행수·소요시간을 남긴다. 실패하면 반쪽
스냅샷을 지우고 non-zero 로 죽는다.

### 재부팅 검증 (2026-08-29)

두 번 재부팅해 확인했다. **개입 없이 30초 안에 전부 복구된다.**

```
docker · docker.socket · cliproxy · ollama · memory-stack · backup.timer
  → 전부 enabled + active
컨테이너 4개 → 30초 내 healthy
iptables 4규칙 영속 · 포트 6개 리스닝 · HTTPS 200 · 기억 붙는 채팅 정상
```

1차에서 **cliproxy 가 죽어 있었다.** `10.77.0.4` 는 wg0 주소인데 cliproxy 가
`wg-quick@wg0` 보다 먼저 떠서, 바인딩 직후 인터페이스 재설정(mtu·route)에
소켓을 잃고 **exit 0 으로 정상 종료**했다. 유닛이 `Restart=on-failure` 라
재시작 대상이 아니었다. 드롭인으로 고쳤다:

```ini
# /etc/systemd/system/cliproxy.service.d/override.conf
[Unit]
After=wg-quick@wg0.service
Wants=wg-quick@wg0.service
[Service]
Restart=always
```

2차 재부팅에서 `active` 확인. 이 유닛은 이 레포 밖(호스트 설정)이다.

**복구는 실증했다** — gz 를 풀어 열고 무결성·행수·대화 본문·벡터까지 확인.

---

## 8. 포크 규모

```
upstream 수정   16파일  +302/-33   전부 백엔드 후크 성격
신규            50+파일 +11,900    add-only
upstream 픽     1건 (헤더 정체성 캐시미스 우회)
```

upstream 에는 **아무것도 보내지 않는다.** `upstream` 리모트는 push URL 을 막아뒀다.
평가 기준은 PR 가능성이 아니라 **리베이스 노출도** — 자세한 것은
[`../FORK.md`](../FORK.md).

---

## 9. 알려진 빈틈

**구조**
- 집 의존이 NPM 하나 남음 — 집이 죽으면 도메인 접속 불가(오버레이 직결은 가능)
- `ollama` 와 `cliproxy` 가 compose 밖 — 스택이 두 갈래로 관리된다

**위생**
- S3 `prod/` 밖 테스트 잔해 114개
- Mac 도커 볼륨 `tdai-memory-core-data`, oci-ko `*.unused` 8.6MB
- `spike/` 694줄

**품질**
- 페르소나가 인프라 작업에만 편향 — 표본이 그것뿐
- Scene Navigation 안내문이 중국어(upstream 하드코딩)
- `MemoryProxy` 에 테스트가 없다(upstream 부터). 캐리 패치 검증 근거가 실배포뿐
