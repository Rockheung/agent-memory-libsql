#!/usr/bin/env python3
"""
Claude Code ↔ TencentDB Agent Memory 훅 어댑터.

MemoryProxy 를 거치지 않고 Claude Code 를 memory-core Gateway 에 직접 붙인다.
LLM 요청 경로를 건드리지 않으므로 기존 구독 인증이 그대로 유지된다.

  UserPromptSubmit  → 회상: L1 검색 + L2 목차 + L3 페르소나를 컨텍스트로 주입
                       (읽기 전용. 프롬프트는 stash 만 하고 쓰지 않는다)
  Stop              → 기록: stash 한 user 발화 + last_assistant_message 를
                       한 번의 /v3/conversation/add 로 전송

설계 원칙:
  · **절대 턴을 깨지 않는다.** 어떤 실패에도 exit 0, 컨텍스트 없이 통과.
  · 블로킹 훅(UserPromptSubmit)은 **읽기만** 한다. 쓰기는 Stop 으로 미뤄
    사용자 대기 시간에서 제거한다.
  · 표준 라이브러리만 사용 — pip 설치 불필요.

설정: $MEMORY_ADAPTER_CONFIG 또는 ~/.claude/memory-adapter.json
"""
from __future__ import annotations
import json, os, sys, time, urllib.request, urllib.error, hashlib, re

STATE_DIR = os.path.expanduser("~/.claude/memory-adapter")
DEFAULT_CONFIG = os.path.expanduser("~/.claude/memory-adapter.json")
LOG = os.path.join(STATE_DIR, "adapter.log")


def log(msg: str) -> None:
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}\n")
    except Exception:
        pass


def load_config() -> dict | None:
    path = os.environ.get("MEMORY_ADAPTER_CONFIG", DEFAULT_CONFIG)
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        log(f"config not found: {path}")
        return None
    except Exception as e:
        log(f"config load failed: {e}")
        return None
    if not cfg.get("enabled", True):
        return None
    for k in ("endpoint", "team_id", "agent_id", "user_id"):
        if not cfg.get(k):
            log(f"config missing required field: {k}")
            return None
    return cfg


def post(cfg: dict, path: str, body: dict, timeout: float) -> dict | None:
    """게이트웨이 POST. 실패는 None 을 돌려주고 절대 raise 하지 않는다."""
    url = cfg["endpoint"].rstrip("/") + path
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + cfg.get("gateway_api_key", "local"))
    req.add_header("x-tdai-service-id", cfg.get("service_id", "default"))
    if cfg.get("user_key"):
        req.add_header("x-tdai-user-key", cfg["user_key"])
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.loads(r.read().decode("utf-8"))
        log(f"POST {path} ok {int((time.time()-t0)*1000)}ms")
        return out.get("data")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:200]
        except Exception:
            pass
        log(f"POST {path} HTTP {e.code} {detail}")
    except Exception as e:
        log(f"POST {path} failed after {int((time.time()-t0)*1000)}ms: {e}")
    return None


def ids(cfg: dict) -> dict:
    d = {"team_id": cfg["team_id"], "agent_id": cfg["agent_id"], "user_id": cfg["user_id"]}
    if cfg.get("task_id"):
        d["task_id"] = cfg["task_id"]
    return d


def session_key(cfg: dict, hook: dict) -> str:
    """Claude Code session_id 를 그대로 쓰되, 프로젝트별로 나누고 싶으면 cwd 를 섞는다."""
    sid = hook.get("session_id") or "unknown"
    if cfg.get("scope_by_cwd"):
        cwd = hook.get("cwd") or ""
        sid = f"{sid}-{hashlib.sha256(cwd.encode()).hexdigest()[:8]}"
    return sid[:128]


def state_path(sid: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", sid)[:120]
    return os.path.join(STATE_DIR, f"{safe}.json")


def read_state(sid: str) -> dict:
    try:
        with open(state_path(sid), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def write_state(sid: str, st: dict) -> None:
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = state_path(sid) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False)
        os.replace(tmp, state_path(sid))
    except Exception as e:
        log(f"state write failed: {e}")


def emit(event: str, context: str | None) -> None:
    """훅 출력. context 가 없으면 아무것도 내보내지 않는다."""
    if context:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": event,
                "additionalContext": context,
            }
        }, ensure_ascii=False))
    sys.exit(0)


# ────────────────────────────── UserPromptSubmit ──────────────────────────────

def on_user_prompt(cfg: dict, hook: dict) -> None:
    prompt = (hook.get("prompt") or "").strip()
    sid = session_key(cfg, hook)
    st = read_state(sid)

    # 이번 턴의 user 발화를 stash. 실제 전송은 Stop 에서 (블로킹 경로에서 쓰기 제거)
    st["pending_user"] = prompt
    st["cwd"] = hook.get("cwd")
    write_state(sid, st)

    if not prompt:
        emit("UserPromptSubmit", None)

    # 6초는 부족하다. ollama 가 임베딩 모델을 5분 유휴에 내리기 때문에, 쉬었다
    # 돌아온 첫 턴은 모델 재적재(3초+)를 문다. 예산을 넘기면 fail-open 이라
    # "에러 없이 기억만 사라진" 상태가 되고 사용자는 눈치채지 못한다.
    budget = float(cfg.get("recall_timeout_seconds", 12))
    deadline = time.time() + budget
    parts: list[str] = []

    # ① L3 페르소나 — 세션당 1회만. 매 턴 넣으면 토큰 낭비 + 프롬프트 캐시 무효화.
    if not st.get("persona_injected") and cfg.get("inject_persona", True):
        core = post(cfg, "/v3/core/read", ids(cfg), max(1.0, deadline - time.time()))
        content = (core or {}).get("content") or ""
        if content.strip():
            limit = int(cfg.get("persona_max_chars", 2000))
            parts.append("## 사용자 프로필 (L3)\n" + content.strip()[:limit])
            st["persona_injected"] = True
            write_state(sid, st)

    # ② L1 원자 기억 — 질의 기반. 매 턴 수행.
    if time.time() < deadline:
        body = dict(ids(cfg)); body["query"] = prompt
        body["limit"] = int(cfg.get("recall_limit", 5))
        res = post(cfg, "/v3/atomic/search", body, max(1.0, deadline - time.time()))
        items = (res or {}).get("items") or []
        thr = float(cfg.get("score_threshold", 0.0))
        lines = [f"- {(it.get('content') or '').strip()}"
                 for it in items if float(it.get("score") or 0) >= thr]
        if lines:
            parts.append("## 관련 기억 (L1)\n" + "\n".join(lines))

    # ③ L2 시나리오 목차 — 세션당 1회. 임베딩을 안 타서 저렴하다.
    if not st.get("scenes_injected") and cfg.get("inject_scenes", True) and time.time() < deadline:
        res = post(cfg, "/v3/scenario/ls", ids(cfg), max(1.0, deadline - time.time()))
        entries = (res or {}).get("entries") or []
        if entries:
            n = int(cfg.get("scene_limit", 10))
            lines = [f"- {e.get('path')}: {(e.get('summary') or '').strip()[:160]}"
                     for e in entries[:n]]
            parts.append("## 축적된 시나리오 (L2)\n" + "\n".join(lines))
            st["scenes_injected"] = True
            write_state(sid, st)

    if not parts:
        emit("UserPromptSubmit", None)

    header = ("다음은 장기 기억 저장소에서 회상한 내용이다. "
              "관련 있을 때만 참고하고, 어긋나면 사용자의 현재 발화를 우선한다.\n\n")
    emit("UserPromptSubmit", header + "\n\n".join(parts))


# ─────────────────────────────────── Stop ────────────────────────────────────

def on_stop(cfg: dict, hook: dict) -> None:
    sid = session_key(cfg, hook)
    st = read_state(sid)
    user_text = (st.pop("pending_user", "") or "").strip()
    # transcript 는 지연되므로 last_assistant_message 를 쓴다 (훅 문서 권고)
    asst_text = (hook.get("last_assistant_message") or "").strip()

    messages = []
    cap = int(cfg.get("max_message_chars", 8000))
    if user_text:
        messages.append({"role": "user", "content": user_text[:cap]})
    if asst_text:
        messages.append({"role": "assistant", "content": asst_text[:cap]})

    write_state(sid, st)
    if not messages:
        sys.exit(0)

    body = dict(ids(cfg))
    body["session_id"] = sid
    body["messages"] = messages
    post(cfg, "/v3/conversation/add", body, float(cfg.get("write_timeout_seconds", 10)))
    sys.exit(0)


def main() -> None:
    try:
        hook = json.load(sys.stdin)
    except Exception as e:
        log(f"stdin parse failed: {e}")
        sys.exit(0)

    # 재귀 가드: 훅 안에서 claude -p 를 부르는 경우, 그 자식 세션의 훅이
    # 다시 발동해 무한 루프가 된다. 자식은 env 를 상속하므로 여기서 끊는다.
    if os.environ.get("MEMORY_ADAPTER_GUARD"):
        log(f"guard hit ({hook.get('hook_event_name')}) — 중첩 실행이므로 skip")
        sys.exit(0)

    cfg = load_config()
    if cfg is None:
        sys.exit(0)

    # 자동화(claude -p 루프)용 경량 모드: L1 만 주입, L3/L2 는 건너뛴다.
    if os.environ.get("MEMORY_ADAPTER_LEAN"):
        cfg["inject_persona"] = False
        cfg["inject_scenes"] = False

    event = hook.get("hook_event_name")
    try:
        if event == "UserPromptSubmit":
            on_user_prompt(cfg, hook)
        elif event == "Stop":
            on_stop(cfg, hook)
    except Exception as e:  # 어떤 예외도 턴을 깨지 않는다
        log(f"unhandled {event}: {type(e).__name__}: {e}")
    sys.exit(0)


if __name__ == "__main__":
    main()
