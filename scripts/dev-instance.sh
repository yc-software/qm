#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-up}" == "up" ]]; then
  npm --prefix "$root" run build:connector-sdk
fi
exec node "$root/scripts/dev/cli.ts" "$@"
