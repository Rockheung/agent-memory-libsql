# ClaudeCodeAdapter

Claude Code 를 **MemoryProxy 없이** memory-core Gateway 에 직접 붙이는 훅 어댑터.

```
Claude Code
  ├─ UserPromptSubmit ─► /v3/core/read · /v3/atomic/search · /v3/scenario/ls
  │                       └─► additionalContext 로 주입
  └─ Stop             ─► /v3/conversation/add   (user + assistant 한 번에)
        ▼
   memory-core :8420   ← L1 추출 / L2 요약 / L3 페르소나는 서버가 백그라운드로
        ▼
   Anthropic 구독은 그대로   ← LLM 요청 경로를 건드리지 않는다
```

## 왜 이게 있나

upstream 이 문서화한 Claude Code 접속 경로는 **MemoryProxy 뿐**이다
(`INSTALL.md:262`). 그런데 프록시는 `ANTHROPIC_BASE_URL` 을 가로채므로
**LLM 이 프록시의 upstream 으로 넘어간다** — 기존 구독 인증을 못 쓴다.
채팅 기억용 MCP 서버도 없다 (MCP 는 MemoryKnowledge 의 `code_*`/`wiki_*` 뿐).

기억 시스템이 호스트에게 실제로 요구하는 건 훅 두 개다. OpenClaw 플러그인이
거는 것도 정확히 두 개다 (`MemoryCore/index.ts:681,808`):

| MemoryCore(OpenClaw) | Claude Code |
|---|---|
| `before_prompt_build` — 회상 주입 | `UserPromptSubmit` |
| `agent_end` — 대화 캡처 | `Stop` |

Claude Code 는 "훅이 없는 호스트"가 아니다. upstream 이 어댑터를 안 만들었을 뿐이다.

## 설계

- **절대 턴을 깨지 않는다.** 어떤 실패에도 `exit 0`, 컨텍스트 없이 통과.
  게이트웨이가 죽어 있어도 Claude Code 는 평소대로 동작한다.
- **블로킹 훅은 읽기만 한다.** `UserPromptSubmit` 은 회상만 하고, user 발화는
  stash 해뒀다가 `Stop` 에서 assistant 응답과 **한 번에** 전송한다.
  사용자 대기 시간에서 쓰기를 완전히 제거하고 순서도 보장된다.
- **transcript 를 파싱하지 않는다.** `Stop` 이 `last_assistant_message` 를
  직접 준다 (훅 문서 권고 — transcript 는 지연된다).
- **L3/L2 는 세션당 1회만 주입.** 매 턴 넣으면 토큰 낭비 + 프롬프트 캐시 무효화.
  L1 은 질의 기반이라 매 턴 수행.
- **표준 라이브러리만.** pip 설치 없음.

## 설치

```bash
cp config.example.json ~/.claude/memory-adapter.json
$EDITOR ~/.claude/memory-adapter.json     # endpoint / user_key / team·agent·user id
```

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command",
                    "command": "/usr/bin/python3 <이 디렉터리>/memory_hook.py",
                    "timeout": 15 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command",
                    "command": "/usr/bin/python3 <이 디렉터리>/memory_hook.py",
                    "timeout": 20 }] }
    ]
  }
}
```

> ⚠️ **`python3` 이 아니라 `/usr/bin/python3` 을 쓸 것.** `python3` 은 pyenv shim 으로
> 잡히면 콜드 스타트가 4배 느려진다 (실측 44ms → 172ms). 훅은 매 턴 돌기 때문에
> 이 차이가 누적된다. Linux 박스에서도 `/usr/bin/python3` 로 동일하게 동작한다.

끄기: `~/.claude/memory-adapter.json` 의 `"enabled": false`.

## 진단

```bash
tail -f ~/.claude/memory-adapter/adapter.log      # 호출별 latency / 실패 사유
ls    ~/.claude/memory-adapter/                   # 세션별 state (stash·주입 여부)
./selftest.sh                                     # 게이트웨이 없이/있이 동작 확인
```

## 알려진 한계

- `task_id` 는 설정 고정값이다. 세션·프로젝트별 자동 매핑 없음.
- 서브에이전트 대화는 캡처하지 않는다 (`SubagentStop` 미사용).
- 툴 호출 내용은 L0 에 안 들어간다 — user/assistant 텍스트만.
- 여러 프로젝트를 한 team/agent 로 쓰면 L2/L3 가 섞인다.
  분리하려면 `scope_by_cwd: true` (L0 세션만 분리되고, L2/L3 는 team+agent 라 여전히 공유).
