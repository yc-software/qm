#!/usr/bin/env bash
set -euo pipefail
if (($# != 5)); then
  echo "usage: bug-video.sh <before-ref> <after-ref> <flow.mjs> <fixtures.json> <out-dir>" >&2
  exit 2
fi
qa=$(cd "$(dirname "$0")" && pwd)
web=$(dirname "$qa")
flow=$(realpath "$3") fixtures=$(realpath "$4")
mkdir -p "$5" && out=$(cd "$5" && pwd)
[[ -d $web/node_modules ]] || npm --prefix "$web" ci --no-audit --no-fund

build() {
  local ref=$1 label=$2 tree
  tree=$(mktemp -d)
  git -C "$web" worktree add -q --detach "$tree" "$ref"
  ln -s "$web/node_modules" "$tree/plugins/web-ui/node_modules"
  (cd "$tree/plugins/web-ui" && npx vite build --outDir "$out/dist-$label" --emptyOutDir) >"$out/build-$label.log" 2>&1 ||
    { tail -20 "$out/build-$label.log" >&2; git -C "$web" worktree remove --force "$tree"; return 1; }
  git -C "$web" worktree remove --force "$tree"
}

record() {
  local label=$1 port mock
  port=$(node -e 's=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
  node "$qa/mock-core.mjs" --dist "$out/dist-$label" --fixtures "$fixtures" --port "$port" >"$out/mock-$label.log" 2>&1 &
  mock=$!
  until curl -sf -o /dev/null "http://localhost:$port/"; do
    kill -0 "$mock" 2>/dev/null || { cat "$out/mock-$label.log" >&2; return 1; }
    sleep 0.2
  done
  local status=0
  node "$qa/record-flow.mjs" --url "http://localhost:$port/" --flow "$flow" --out "$out" --label "$label" || status=$?
  kill "$mock"
  grep MISS "$out/mock-$label.log" | sed "s/^/$label: /" || true
  return "$status"
}

build "$1" before & b=$!
build "$2" after & a=$!
wait $b && wait $a
record before & b=$!
record after & a=$!
failed=()
wait $b || failed+=(before)
wait $a || failed+=(after)
"$qa/side-by-side.sh" "$out/before.mp4" "$out/after.mp4" "$out/before-after.mp4" \
  "Before $(git -C "$web" rev-parse --short "$1")" "After $(git -C "$web" rev-parse --short "$2")"
for label in "${failed[@]}"; do echo "$label flow failed: $out/$label-report.json" >&2; done
((${#failed[@]} == 0))
