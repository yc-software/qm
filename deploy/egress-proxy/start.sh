#!/bin/sh
set -eu

firewall() {
  bin="$1"; shift
  if command -v "$bin" >/dev/null 2>&1 && "$bin" "$@" 2>/dev/null; then return 0; fi
  echo "[egress] WARN: could not install metadata firewall ($bin $*) — NET_ADMIN missing?" >&2
}
firewall iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT
firewall ip6tables -A OUTPUT -d fd00:ec2::254 -j REJECT

node /app/src/egress-authz-main.ts &
AUTHZ_PID=$!
envoy -c /app/envoy.yaml &
ENVOY_PID=$!
trap 'kill -TERM $AUTHZ_PID $ENVOY_PID 2>/dev/null; wait; exit 0' TERM INT
while kill -0 "$AUTHZ_PID" 2>/dev/null && kill -0 "$ENVOY_PID" 2>/dev/null; do
  sleep 1
done
kill -TERM "$AUTHZ_PID" "$ENVOY_PID" 2>/dev/null || true
wait || true
exit 1
