#!/usr/bin/env bash
# 훅 어댑터 자체 검증. Claude Code 설정을 건드리지 않고 훅 입력을 직접 먹인다.
set -uo pipefail
PY=/usr/bin/python3
HOOK="$(cd "$(dirname "$0")" && pwd)/memory_hook.py"
SID="selftest-$(date +%s)"
PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
ng(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }

run(){ echo "$1" | "$PY" "$HOOK" 2>/dev/null; }
rc(){ echo "$1" | "$PY" "$HOOK" >/dev/null 2>&1; echo $?; }

echo "── T1. 설정 없음 → 조용히 통과 (턴을 깨지 않는다)"
P1=$($PY -c "import json,sys;print(json.dumps({'hook_event_name':'UserPromptSubmit','session_id':sys.argv[1],'prompt':'hi'}))" "$SID")
export MEMORY_ADAPTER_CONFIG=/nonexistent
T1OUT=$(printf '%s' "$P1" | "$PY" "$HOOK" 2>/dev/null); T1RC=$?
unset MEMORY_ADAPTER_CONFIG
[ "$T1RC" -eq 0 ] && ok "exit 0" || ng "exit=$T1RC"
[ -z "$T1OUT" ] && ok "출력 없음" || ng "출력이 있음: $T1OUT"

echo "── T2. 깨진 stdin → 조용히 통과"
[ "$(echo 'not-json' | "$PY" "$HOOK" >/dev/null 2>&1; echo $?)" = 0 ] && ok "exit 0" || ng "exit != 0"

echo "── T3. 게이트웨이 다운 → 조용히 통과 (fail-open)"
DOWN=$(mktemp); sed 's#"endpoint": *"[^"]*"#"endpoint": "http://127.0.0.1:59999"#' "${MEMORY_ADAPTER_CONFIG:-$HOME/.claude/memory-adapter.json}" > "$DOWN" 2>/dev/null
if [ -s "$DOWN" ]; then
  t0=$($PY -c 'import time;print(time.time())')
  out=$(MEMORY_ADAPTER_CONFIG="$DOWN" run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$SID-down\",\"prompt\":\"hi\"}")
  t1=$($PY -c 'import time;print(time.time())')
  [ -z "$out" ] && ok "출력 없음" || ng "출력이 있음: $out"
  $PY -c "assert $t1-$t0 < 12, 'too slow'; print(f'  ✅ {($t1-$t0):.2f}s 안에 포기')" || ng "타임아웃 초과"
else ng "설정 파일이 없어 T3 건너뜀"; fi
rm -f "$DOWN"

echo "── T4. 정상 경로: UserPromptSubmit → 컨텍스트 주입"
t0=$($PY -c 'import time;print(time.time())')
OUT=$(run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$SID\",\"cwd\":\"$PWD\",\"prompt\":\"중앙화 스토리지를 무엇으로 결정했더라?\"}")
t1=$($PY -c 'import time;print(time.time())')
if echo "$OUT" | "$PY" -c "
import sys,json
d=json.load(sys.stdin)
c=d['hookSpecificOutput']['additionalContext']
assert d['hookSpecificOutput']['hookEventName']=='UserPromptSubmit'
print('  ✅ additionalContext', len(c), '자')
for sec in ('L3','L1','L2'):
    print(f'     {\"✅\" if sec+\")\" in c or \"(\"+sec in c else \"—\"} {sec}')
" 2>/dev/null; then PASS=$((PASS+1)); else ng "주입 실패: $(echo "$OUT" | head -c 200)"; fi
$PY -c "print(f'  ⏱  {($t1-$t0):.2f}s')"

echo "── T5. 정상 경로: Stop → L0 기록"
BEFORE=$($PY - <<PYX
import json,urllib.request,os
cfg=json.load(open(os.environ.get("MEMORY_ADAPTER_CONFIG", os.path.expanduser("~/.claude/memory-adapter.json"))))
b={k:cfg[k] for k in ("team_id","agent_id","user_id")}
r=urllib.request.Request(cfg["endpoint"]+"/v3/conversation/count",data=json.dumps(b).encode(),method="POST")
r.add_header("Content-Type","application/json"); r.add_header("Authorization","Bearer "+cfg.get("gateway_api_key","local"))
r.add_header("x-tdai-service-id",cfg.get("service_id","default"))
if cfg.get("user_key"): r.add_header("x-tdai-user-key",cfg["user_key"])
print(json.load(urllib.request.urlopen(r,timeout=10))["data"]["total"])
PYX
) || BEFORE=-1
run "{\"hook_event_name\":\"Stop\",\"session_id\":\"$SID\",\"last_assistant_message\":\"셀프테스트 응답입니다.\"}" >/dev/null
sleep 2
AFTER=$($PY - <<PYX
import json,urllib.request,os
cfg=json.load(open(os.environ.get("MEMORY_ADAPTER_CONFIG", os.path.expanduser("~/.claude/memory-adapter.json"))))
b={k:cfg[k] for k in ("team_id","agent_id","user_id")}
r=urllib.request.Request(cfg["endpoint"]+"/v3/conversation/count",data=json.dumps(b).encode(),method="POST")
r.add_header("Content-Type","application/json"); r.add_header("Authorization","Bearer "+cfg.get("gateway_api_key","local"))
r.add_header("x-tdai-service-id",cfg.get("service_id","default"))
if cfg.get("user_key"): r.add_header("x-tdai-user-key",cfg["user_key"])
print(json.load(urllib.request.urlopen(r,timeout=10))["data"]["total"])
PYX
) || AFTER=-1
echo "  L0 건수: $BEFORE → $AFTER"
[ "$AFTER" -eq $((BEFORE+2)) ] 2>/dev/null && ok "user+assistant 2건 기록" || ng "기대 $((BEFORE+2)), 실제 $AFTER"

echo; echo "═══ PASS=$PASS  FAIL=$FAIL ═══"
[ "$FAIL" -eq 0 ]
