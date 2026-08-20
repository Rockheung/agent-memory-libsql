#!/usr/bin/env bash
# 최초 1회: admin / team / agent 를 만들고 .env 에 ID 를 채운다.
#
# core 만 먼저 띄운 상태에서 실행한다:
#   docker compose up -d core
#   ./bootstrap.sh
#   docker compose up -d
#
# 멱등하지 않다 — init-admin 은 빈 DB 를 요구하므로 재실행하려면 Turso 를 비워야 한다.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "먼저 cp .env.example .env 후 값을 채우세요"; exit 1; }
set -a; . ./.env; set +a

PORT="${EDGE_PORT:-8090}"
# core 는 외부에 노출되지 않으므로 컨테이너 안에서 호출한다
api() { docker compose exec -T core sh -c "curl -sS --max-time 20 -X POST \
  -H 'Content-Type: application/json' -H 'x-tdai-service-id: ${SPACE_ID:-default}' \
  -H 'Authorization: Bearer ${GATEWAY_API_KEY}' ${2:+-H \"x-tdai-user-key: $2\"} \
  -d '$3' http://127.0.0.1:8420$1"; }

echo "1) admin 생성"
ADMIN=$(api /v3/internal/meta/user/init-admin "" "{\"username\":\"admin\"}")
UKEY=$(echo "$ADMIN" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("data",{}).get("user_key",""))')
UID_=$(echo "$ADMIN" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("data",{}).get("user_id",""))')
[ -n "$UKEY" ] || { echo "   실패: $ADMIN"; echo "   (이미 admin 이 있으면 Turso 의 meta_* 를 비워야 한다 — 단 WHERE 1=1 로!)"; exit 1; }
umask 077; printf '%s' "$UKEY" > .admin-key
echo "   user_id=$UID_  (user_key → .admin-key)"

echo "2) team 생성"
TEAM=$(api /v3/meta/team/create "$UKEY" "{\"name\":\"${TEAM_NAME:-rock}\",\"owner_user_id\":\"$UID_\"}")
TID=$(echo "$TEAM" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("team_id",""))')
echo "   team_id=$TID"

echo "3) agent 생성"
AGENT=$(api /v3/meta/agent/create "$UKEY" "{\"team_id\":\"$TID\",\"name\":\"${AGENT_NAME:-rock-agent}\",\"owner_user_id\":\"$UID_\"}")
AID=$(echo "$AGENT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("agent_id",""))')
echo "   agent_id=$AID"

echo "4) .env 갱신"
python3 - "$TID" "$AID" <<'PY'
import re, sys
tid, aid = sys.argv[1], sys.argv[2]
s = open(".env", encoding="utf-8").read()
s = re.sub(r'^TEAM_ID=.*$',  f'TEAM_ID={tid}',  s, flags=re.M)
s = re.sub(r'^AGENT_ID=.*$', f'AGENT_ID={aid}', s, flags=re.M)
open(".env","w",encoding="utf-8").write(s)
PY
echo
echo "완료. 이제:  docker compose up -d"
echo "클라이언트 base URL:  http://<host>:${PORT}/v1"
