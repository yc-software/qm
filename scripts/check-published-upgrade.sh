#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point at an empty, disposable database as a non-bootstrap superuser}"
: "${QM_UPGRADE_APP_URL:?QM_UPGRADE_APP_URL must point at the same database as a login that does not own its schema}"
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
git rev-parse --verify --quiet "refs/tags/$base" >/dev/null || git fetch --quiet --depth 1 origin "refs/tags/$base:refs/tags/$base"
git worktree add --quiet --detach "$worktree" "$base"

secret() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'; }
secrets=()
for name in CAPABILITY_SECRET CONNECTOR_SECRET_KEY CORE_SIGNING_SECRET PORTAL_IDENTITY_SECRET SKILL_SIGNING_SECRET; do
  secrets+=("$name=$(secret)")
done

migrate() {
  local label=$1 dir=$2 url=$3
  echo "::group::migrate with $label"
  local log
  log=$(mktemp)
  local status=0
  (cd "$dir" && env -i PATH="$PATH" HOME="$HOME" DATABASE_URL="$url" "${secrets[@]}" node src/migrate-main.ts) >"$log" 2>&1 || status=$?
  cat "$log"
  echo "::endgroup::"
  if [ "$status" -ne 0 ]; then
    echo "::error::migrating with $label exited with status $status; see the log above" >&2
    exit "$status"
  fi
}

echo "Installing published release $base"
(cd "$worktree" && npm ci --ignore-scripts --no-audit --no-fund && npm run build:connector-sdk) >/dev/null

migrate "$base" "$worktree" "$DATABASE_URL"
DATABASE_URL="$DATABASE_URL" node "$root/scripts/seed-upgrade-rows.mjs"
echo "Handing the $base objects to the app login, as an install by that login would leave them"
node --input-type=module -e '
  import pg from "pg";
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const role = decodeURIComponent(new URL(process.env.QM_UPGRADE_APP_URL).username);
  await client.query(`REASSIGN OWNED BY CURRENT_USER TO ${client.escapeIdentifier(role)}`);
  await client.end();'
migrate "this checkout" "$root" "$QM_UPGRADE_APP_URL"
migrate "this checkout (restart)" "$root" "$QM_UPGRADE_APP_URL"
echo "Upgrade from $base applied cleanly."
