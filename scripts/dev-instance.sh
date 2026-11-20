#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cache="$HOME/.cache/qm-dev"
need="$(cat "$root/.node-version")"
if [[ "$(printf '%s\n' "$need" "$(node -v 2>/dev/null | tr -d v)" | sort -V | head -1)" != "$need" ]]; then
  if [[ ! -x "$cache/node-$need/bin/node" ]]; then
    arch="$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')"
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    echo "node $need+ required: fetching node v$need into $cache" >&2
    rm -rf "$cache/node-$need.tmp" && mkdir -p "$cache/node-$need.tmp"
    curl -fsSL "https://nodejs.org/dist/v$need/node-v$need-$os-$arch.tar.xz" | tar -xJ -C "$cache/node-$need.tmp" --strip-components=1
    mv "$cache/node-$need.tmp" "$cache/node-$need"
  fi
  export PATH="$cache/node-$need/bin:$PATH"
fi
if [[ "${1:-up}" == "up" ]]; then
  npm --prefix "$root" run build:connector-sdk
fi
exec node "$root/scripts/dev/cli.ts" "$@"
