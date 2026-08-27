#!/usr/bin/env python3
"""mem — 기억할 사실을 게이트웨이에 직접 넣는다. LLM 을 거치지 않는다.

  mem "oci-ko 의 백업은 매일 03:20 KST 에 돈다"
  echo "긴 내용" | mem
  mem -a "어시스턴트 발화로 기록"        # 기본은 user 역할

`claude -p` 로 같은 일을 하면 Claude Code 시스템 프롬프트 때문에 호출당
2만 토큰 넘게 든다. 기록만 할 거면 이쪽이 맞다 — 클라이언트 토큰 0.
서버가 자기 모델로 L1 을 뽑는 건 어느 쪽이든 동일하다.

설정은 훅과 공유한다: $MEMORY_ADAPTER_CONFIG 또는 ~/.claude/memory-adapter.json
"""
from __future__ import annotations
import json, os, sys, time, urllib.request, urllib.error

CONFIG = os.environ.get("MEMORY_ADAPTER_CONFIG", os.path.expanduser("~/.claude/memory-adapter.json"))


def die(msg: str, code: int = 1):
    print(f"mem: {msg}", file=sys.stderr)
    sys.exit(code)


def main() -> None:
    args = sys.argv[1:]
    role = "user"
    if args and args[0] in ("-a", "--assistant"):
        role, args = "assistant", args[1:]
    text = " ".join(args).strip() or sys.stdin.read().strip()
    if not text:
        die("내용이 비었다. 인자나 stdin 으로 넘겨라.", 2)

    try:
        cfg = json.load(open(CONFIG, encoding="utf-8"))
    except Exception as e:
        die(f"설정을 못 읽었다 ({CONFIG}): {e}")

    for k in ("endpoint", "team_id", "agent_id", "user_id"):
        if not cfg.get(k):
            die(f"설정에 {k} 가 없다")

    # 세션을 날짜로 묶는다. 매번 새 세션이면 L2/L3 가 조각난다.
    body = {
        "team_id": cfg["team_id"], "agent_id": cfg["agent_id"], "user_id": cfg["user_id"],
        "session_id": "mem-" + time.strftime("%Y%m%d"),
        "messages": [{"role": role, "content": text[: int(cfg.get("max_message_chars", 8000))]}],
    }
    if cfg.get("task_id"):
        body["task_id"] = cfg["task_id"]

    headers = {"content-type": "application/json", "x-tdai-service-id": cfg.get("service_id", "default")}
    if cfg.get("gateway_api_key"):
        headers["authorization"] = "Bearer " + cfg["gateway_api_key"]
    if cfg.get("user_key"):
        headers["x-tdai-user-key"] = cfg["user_key"]

    req = urllib.request.Request(
        cfg["endpoint"].rstrip("/") + "/v3/conversation/add",
        data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=float(cfg.get("write_timeout_seconds", 10))) as r:
            res = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        die(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}")
    except Exception as e:
        die(f"전송 실패: {e}")

    # 이 API 는 실패해도 HTTP 200 을 준다. 봉투의 code 를 봐야 한다.
    if res.get("code") != 0:
        die(f"게이트웨이 거부: code={res.get('code')} {res.get('message')}")
    print(f"기록됨 ({role}, {len(text)}자, {int((time.time()-t0)*1000)}ms)")


if __name__ == "__main__":
    main()
