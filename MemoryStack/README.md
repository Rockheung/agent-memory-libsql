# MemoryStack

cliproxy 앞에 기억 계층을 끼우는 도커 세트. **게이트웨이는 무상태다** —
모든 상태가 Turso + S3 호환 오브젝트 스토리지에 있다.

```
클라이언트 (BrowserOS / LibreChat / 임의 OpenAI 호환)
      │  base URL 만 바꾸면 됨
      ▼
edge (nginx :EDGE_PORT)   ← team/agent/task 헤더 주입, /v1/models 우회
      ▼
memory-proxy (:8096)      ← 세션 초기화 · 컨텍스트 주입 · 대화 기록
      ├─────────────────► cliproxy (외부)    모델 라우팅 · effort · web_search
      └─────────────────► core (:8420)       L0~L3 · Skill
                              ├─► Turso       메타 · L0/L1 · 벡터 · Skill
                              └─► S3 호환     L2/L3 md · JSONL · checkpoint · 첨부
```

## 왜 엣지가 필요한가

1. **헤더 주입** — BrowserOS 등 클라이언트 프로바이더 설정에는 커스텀 헤더 필드가
   없다. MemoryProxy 의 `headerAutoSelect` 가 요구하는 `x-team-id` / `x-agent-id` /
   `x-task-id` 를 여기서 붙여 세션 초기화 폼을 건너뛴다.
2. **`/v1/models`** — MemoryProxy 화이트리스트에 없어 404 가 난다. cliproxy 것을 그대로 내준다.

## 설치

```bash
cp .env.example .env && $EDITOR .env     # Turso / S3 / cliproxy 값 채우기
docker compose up -d core                # 커널 먼저
./bootstrap.sh                           # admin/team/agent 생성 → .env 에 ID 기록
docker compose up -d                     # 전체 기동
```

클라이언트에는 `http://<host>:<EDGE_PORT>/v1` 을 base URL 로 준다.

## 상태가 어디에 있나

| | 위치 |
|---|---|
| team/user/agent/task/ACL | Turso `meta_*` |
| L0 대화 · L1 원자기억 · 벡터 | Turso `l0_*` / `l1_*` |
| Skill (본문 포함) | Turso `skills` / `skill_fts` / `skill_vec` |
| L2/L3 마크다운 · JSONL · checkpoint · 생성이력 · Skill 첨부 | S3 호환 |
| **컨테이너 로컬** | `.metadata/manifest.json` 뿐 (진단용, 재생성됨) |

→ **볼륨 백업이 필요 없다.** 컨테이너를 날려도 다시 띄우면 같은 기억을 본다.
`proxy-data` 볼륨만 세션 초기화 상태를 들고 있고, 유실되면 세션 폼을 다시 탈 뿐이다.

## 주의

- **`GATEWAY_API_KEY` 를 반드시 채운다.** 비우면 데이터 평면이 아무 Bearer 나 통과시킨다.
- **`AGENT_ID` 를 머신별로 나누지 않는다.** L2/L3 페르소나의 정체성이 `(teamId, agentId)`
  라 나누면 인격이 쪼개진다.
- **Turso 벡터 테이블에 `WHERE` 없는 `DELETE` 를 쓰지 않는다.** 벡터 인덱스가 깨진다
  (`REINDEX` 로 복구). 자세한 건 `docs/11-LIBSQL-MEMORY-STORE.md` 부록 2.
- **Oracle Object Storage** 를 쓸 경우 연합(SAML) 사용자가 아니라 **로컬 사용자**에
  customer secret key 를 만들어야 하고, 전파에 2분+ 걸린다.
