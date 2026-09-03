#!/usr/bin/env bash
set -euo pipefail

worktree=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
policy="$worktree/deploy/core/grok-requirements.toml"
test "$(uname -s)" = "Linux" || {
  echo "HARNESS=grok dev-instance requires Linux bubblewrap policy enforcement" >&2
  exit 1
}
launcher=$(command -v bwrap) || {
  echo "HARNESS=grok dev-instance needs bubblewrap (bwrap) with overlay support" >&2
  exit 1
}
test -f "$policy" || {
  echo "HARNESS=grok dev-instance policy is missing: $policy" >&2
  exit 1
}
exec "$launcher" \
  --die-with-parent \
  --bind / / \
  --overlay-src /etc \
  --tmp-overlay /etc \
  --dir /etc/grok \
  --ro-bind "$policy" /etc/grok/requirements.toml \
  -- "$@"
