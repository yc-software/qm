#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$root" ]]; then
  printf 'dev-instance: not inside a git worktree\n' >&2
  exit 1
fi

exec bash "$root/scripts/dev-instance.sh" "$@"
