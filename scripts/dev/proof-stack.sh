#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGS="${PROOF_STACK_LOGS:-/tmp/proof-stack}"
BASE=http://localhost:9303
PIDS=()

kill_pids() {
  for pid in "$@"; do kill "$pid" 2>/dev/null || true; done
}

fail() {
  echo "proof-stack: $1" >&2
  for name in "${@:2}"; do
    if [ -f "$LOGS/$name.log" ]; then
      printf -- '--- %s ---\n' "$name" >&2
      tail -n 20 "$LOGS/$name.log" >&2
    fi
  done
  kill_pids ${PIDS[@]+"${PIDS[@]}"}
  exit 1
}

free_port() {
  local holders
  holders="$(ss -ltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)"
  [ -n "$holders" ] || return 0
  kill_pids $holders
  sleep 1
  for pid in $holders; do kill -9 "$pid" 2>/dev/null || true; done
}

up() {
  [ -f "$ROOT/plugins/web-ui/dist-web/index.html" ] ||
    fail "plugins/web-ui/dist-web/index.html is missing; run 'npm --prefix plugins/web-ui run build' first"
  [ -n "${ANTHROPIC_API_KEY:-}" ] ||
    fail "ANTHROPIC_API_KEY is unset; without a model key the portal redirects admins to onboarding"
  cd "$ROOT"
  mkdir -p "$LOGS"
  for port in 9301 9302 9303; do free_port "$port"; done
  local secret portal_secret waited=0
  secret="$(openssl rand -hex 24)"
  portal_secret="$(openssl rand -hex 24)"
  CORE_SIGNING_SECRET="$secret" CORE_ORG_ID=acme ORG_ID=acme SESSION_STORE=memory RUN_STORE=memory \
    SANDBOX_BACKEND=local SHUTDOWN_DRAIN_MS=2000 ADMIN_GRANTS=proof:org_admin PORT=9301 \
    PUBLIC_WEB_URL="$BASE" setsid node src/index.ts >"$LOGS/core.log" 2>&1 &
  PIDS+=("$!")
  CORE_SIGNING_SECRET="$secret" CORE_ORG_ID=acme PORT=9302 CORE_API_URL=http://localhost:9301 \
    WEB_UI_PRINCIPALS= LOOPS_USERS=proof WEB_UI_PUBLIC_URL="$BASE" \
    setsid node plugins/web-ui/server/index.ts >"$LOGS/web.log" 2>&1 &
  PIDS+=("$!")
  CORE_SIGNING_SECRET="$secret" CORE_ORG_ID=acme PORT=9303 PORTAL_PUBLIC_URL="$BASE" \
    CORE_API_URL=http://localhost:9301 WEB_UI_UPSTREAM=http://localhost:9302 \
    ADMIN_UPSTREAM=http://localhost:9302/admin PORTAL_SESSION_SECRET="$portal_secret" \
    NODE_ENV=development PORTAL_LOCAL_AUTH_BYPASS=1 PORTAL_DEV_PRINCIPAL=proof \
    setsid node plugins/portal/src/index.ts >"$LOGS/portal.log" 2>&1 &
  PIDS+=("$!")
  until curl -fs -o /dev/null "$BASE/api/loops"; do
    for pid in "${PIDS[@]}"; do
      kill -0 "$pid" 2>/dev/null || fail "a stack process exited before the portal answered" core web portal
    done
    waited=$((waited + 1))
    [ "$waited" -lt 60 ] || fail "the stack did not answer on $BASE within 60s" core web portal
    sleep 1
  done
  curl -fsS -o /dev/null -X POST "$BASE/api/loops" -H 'content-type: application/json' \
    -H "Origin: $BASE" -H 'Sec-Fetch-Site: same-origin' \
    -d '{"name":"Software factory (demo)","playbook":"Review every open pull request and land the ones that are green.","successCondition":"Each green pull request is merged or carries a blocking review.","shipActions":[{"action":"open_pr","gate":"auto"}]}' ||
    fail "seeding the demo loop failed" core web portal
  echo "$BASE"
}

case "${1-}" in
up) up ;;
url) echo "$BASE" ;;
*) echo "usage: proof-stack.sh up|url" >&2 && exit 2 ;;
esac
