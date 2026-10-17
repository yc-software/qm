#!/bin/sh
# Push a Gmail connector access token from the local env into a QM test instance.
# Run with the token in $VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM (credential broker env name).
# The remote side runs plugins/web-ui/server/settok.ts, which exits nonzero unless the
# core API answers HTTP 200 — and this script propagates that failure instead of
# swallowing it (the old inline `| tail -1 | tee` pipeline always exited 0).
set -eu

SSH_CMD=${PUSH_GMAIL_SSH:-"$HOME/mig/ssh.sh"}
HOST=${PUSH_GMAIL_HOST:-gmail.googleapis.com}
ACCOUNT_TYPE=${PUSH_GMAIL_ACCOUNT_TYPE:-personal}

[ -n "${VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM:-}" ] || { echo "push-gmail: no gmail token in env" >&2; exit 1; }

# No pipes around node on the remote side: its exit code must reach ssh untouched.
out=$(printf '%s' "$VAULT_TOKEN_GMAIL_GOOGLEAPIS_COM" | timeout 90 "$SSH_CMD" \
  "cd ~/qm-test/plugins/web-ui && set -a && . ~/qm-test/test.env && set +a && \
   node server/settok.ts $HOST $ACCOUNT_TYPE >> ~/qm-test/token-reload.log 2>&1; \
   ec=\$?; tail -1 ~/qm-test/token-reload.log; exit \$ec") || {
  echo "push-gmail: remote settok failed: $out" >&2
  exit 1
}
echo "$out"
case "$out" in
  *" status 200 "*) ;;
  *) echo "push-gmail: settok did not report HTTP 200" >&2; exit 1 ;;
esac
