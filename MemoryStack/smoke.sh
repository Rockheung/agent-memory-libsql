#!/usr/bin/env bash
# 게이트웨이 스모크. 기동만으로는 안 잡히는 경로까지 친다.
#
#   ./smoke.sh [port]        기본 8420
#
# 왜 필요한가: 번들 이미지로 바꿨을 때 /health 는 200 인데
# /v3/meta/auth/verify 만 500 이었다(모듈 상대경로 데이터 파일 누락).
# 프록시 경유 인증이 전부 실패하는데 헬스체크는 통과한다.
set -uo pipefail
PORT="${1:-8420}"
cd "$(dirname "$0")"
K=$(grep '^GATEWAY_API_KEY=' .env | cut -d= -f2-)
T=$(grep '^TEAM_ID=' .env | cut -d= -f2-)
A=$(grep '^AGENT_ID=' .env | cut -d= -f2-)
U=$(grep '^USER_ID=' .env | cut -d= -f2- 2>/dev/null)
: "${U:=$(grep '^USER_ID=' .env | cut -d= -f2-)}"
ID="\"team_id\":\"$T\",\"agent_id\":\"$A\",\"user_id\":\"$U\""
B="http://127.0.0.1:$PORT"
H=(-H "authorization: Bearer $K" -H "x-tdai-service-id: default" -H "content-type: application/json")
fail=0

chk() { # 이름 기대코드 실제코드 부가정보
  if [ "$2" = "$3" ]; then printf "  ok   %-26s %s\n" "$1" "${4:-}"
  else printf "  FAIL %-26s 기대 %s / 실제 %s %s\n" "$1" "$2" "$3" "${4:-}"; fail=1; fi
}

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$B/health")
chk "/health" 200 "$code"

# 봉투 code 를 봐야 한다 — 이 API 는 실패해도 HTTP 200 을 준다.
env_code() { python3 -c "import json,sys
try: print(json.load(sys.stdin).get('code'))
except Exception: print('parse-error')"; }

c=$(curl -sS --max-time 20 -X POST "$B/v3/meta/auth/verify" "${H[@]}" -d '{"user_key":"probe-invalid"}' -o /tmp/.sm1 -w '%{http_code}')
chk "/v3/meta/auth/verify" 200 "$c" "(envelope=$(env_code < /tmp/.sm1))"

c=$(curl -sS --max-time 30 -X POST "$B/v3/atomic/search" "${H[@]}" -d "{\"query\":\"smoke\",$ID,\"limit\":1}" -o /tmp/.sm2 -w '%{http_code}')
chk "/v3/atomic/search" 200 "$c" "(envelope=$(env_code < /tmp/.sm2))"

c=$(curl -sS --max-time 30 -X POST "$B/v3/core/read" "${H[@]}" -d "{$ID}" -o /tmp/.sm3 -w '%{http_code}')
chk "/v3/core/read" 200 "$c" "(envelope=$(env_code < /tmp/.sm3))"

c=$(curl -sS --max-time 30 -X POST "$B/v3/scenario/ls" "${H[@]}" -d "{$ID}" -o /tmp/.sm4 -w '%{http_code}')
chk "/v3/scenario/ls" 200 "$c" "(envelope=$(env_code < /tmp/.sm4))"

rm -f /tmp/.sm1 /tmp/.sm2 /tmp/.sm3 /tmp/.sm4
[ $fail = 0 ] && echo "  → 전부 통과" || echo "  → 실패 있음"
exit $fail
