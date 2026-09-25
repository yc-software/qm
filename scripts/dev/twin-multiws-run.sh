#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${ARGA_API_KEY:?}"
: "${ANTHROPIC_API_KEY:?}"
export CORE_SIGNING_SECRET="${CORE_SIGNING_SECRET:-$(openssl rand -hex 24)}"
export SLACK_EVENTS_PORT=8182
export B_SLACK_EVENTS_PORT=8283

echo "== provisioning primary twin =="
eval "$(node test/live-slack/arga-provision.ts up | grep '^export ')"

echo "== provisioning batch twin =="
B_ENV="$(node test/live-slack/arga-provision.ts up | grep '^export ' | sed 's/^export /export B_/')"
eval "$B_ENV"
export B_SLACK_EVENTS_PORT=8283

cleanup() {
  set +e
  node cli/bin/qm.ts dev --ci down
  ARGA_TWIN_RUN_ID="$ARGA_TWIN_RUN_ID" node test/live-slack/arga-provision.ts down
  ARGA_TWIN_RUN_ID="$B_ARGA_TWIN_RUN_ID" node test/live-slack/arga-provision.ts down
}
trap cleanup EXIT

export SLACK_ACCOUNTS="$(node -e '
const req = (n) => { const v = process.env[n]; if (!v) throw new Error(n); return v; };
console.log(JSON.stringify([{
  id: "batch-twin",
  botToken: req("B_SLACK_BOT_TOKEN"),
  eventsMode: "http",
  signingSecret: req("B_SLACK_SIGNING_SECRET"),
  eventsPort: Number(req("B_SLACK_EVENTS_PORT")),
  apiUrl: req("B_SLACK_API_URL"),
  allowFrom: ["e2e-alice@slack-twin.local", "e2e-qa@slack-twin.local"],
}]));
')"

echo "== booting ci instance =="
node cli/bin/qm.ts dev --ci up

echo "== driving scenarios =="
node scripts/dev/twin-multiws-check.ts
