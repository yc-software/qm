#!/usr/bin/env bash
# Upgrade a database from the latest published release to this checkout.
# Seeds a row into every table the release created so data-dependent migrations run.
# Usage: DATABASE_URL=postgres://... scripts/check-published-upgrade.sh [base-tag]
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point at an empty, disposable database}"
root=$(git rev-parse --show-toplevel)
cd "$root"

base=${1:-${QM_UPGRADE_FROM:-}}
if [ -z "$base" ]; then
  git fetch --quiet --force origin 'refs/tags/v*:refs/tags/v*'
  base=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -1)
fi
[ -n "$base" ] || { echo "no published release tag found" >&2; exit 1; }

worktree=$(mktemp -d)
cleanup() { git worktree remove --force "$worktree" >/dev/null 2>&1 || rm -rf "$worktree"; }
trap cleanup EXIT
git fetch --quiet --depth 1 origin "refs/tags/$base:refs/tags/$base" 2>/dev/null || true
git worktree add --quiet --detach "$worktree" "$base"

secret() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'; }
secrets=()
for name in CAPABILITY_SECRET CONNECTOR_SECRET_KEY CORE_SIGNING_SECRET PORTAL_IDENTITY_SECRET SKILL_SIGNING_SECRET; do
  secrets+=("$name=$(secret)")
done

migrate() {
  local label=$1 dir=$2
  echo "::group::migrate with $label"
  (cd "$dir" && env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$DATABASE_URL" "${secrets[@]}" node src/migrate-main.ts)
  echo "::endgroup::"
}

echo "Installing published release $base"
(cd "$worktree" && npm ci --ignore-scripts --no-audit --no-fund && npm run build:connector-sdk) >/dev/null

migrate "$base" "$worktree"
DATABASE_URL="$DATABASE_URL" node "$root/scripts/seed-upgrade-rows.mjs"
migrate "this checkout" "$root"
migrate "this checkout (restart)" "$root"
echo "Upgrade from $base applied cleanly."
