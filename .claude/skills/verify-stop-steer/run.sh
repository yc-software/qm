#!/usr/bin/env bash
set -euo pipefail

TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/qm-tla"
JAR="$CACHE/tla2tools-$TLA_VERSION.jar"
OUT="${VERIFY_OUT:-${TMPDIR:-/tmp}/verify-stop-steer}"
MSGS="${MSGS:-{1\}}"

FIXES='"freeze_on_stop","serial_controls","stop_returns_inputs","stop_terminal_target","drop_replay_push","optimistic_submit","steer_rows_until_landed","chip_skips_started","no_self_steer","turn_reply_resyncs","fresh_queue_sync","sync_includes_transcript"'
INVARIANTS=(StopFreezesReply NoTurnAfterStop StopNotIgnored NoSilentLoss DeliveredOnce ShownOnce SentIsShown ControlsMatchServer)

declare -A CURRENT=(
  [StopFreezesReply]=fail [NoTurnAfterStop]=fail [StopNotIgnored]=fail [NoSilentLoss]=fail
  [DeliveredOnce]=pass [ShownOnce]=fail [SentIsShown]=fail [ControlsMatchServer]=fail
)
declare -A FIXED=(
  [StopFreezesReply]=pass [NoTurnAfterStop]=pass [StopNotIgnored]=pass [NoSilentLoss]=pass
  [DeliveredOnce]=pass [ShownOnce]=pass [SentIsShown]=fail [ControlsMatchServer]=pass
)
declare -A BREAKS=([skip_ack]=DeliveredOnce [stop_only_target]=NoTurnAfterStop)

fetch_tlc() {
  command -v java >/dev/null || { echo "java (11+) is required" >&2; exit 2; }
  mkdir -p "$CACHE"
  if [ ! -f "$JAR" ]; then
    curl -fsSL -o "$JAR.tmp" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
    mv "$JAR.tmp" "$JAR"
  fi
  echo "$TLA_SHA256  $JAR" | sha256sum -c --quiet - || { rm -f "$JAR"; echo "tla2tools checksum mismatch" >&2; exit 2; }
}

tlc() {
  local name=$1 invariant=$2 fixes=$3 breaks=$4 workers=$5
  local dir="$OUT/$name"
  rm -rf "$dir" && mkdir -p "$dir"
  cp "$HERE/StopSteer.tla" "$dir/"
  printf 'SPECIFICATION Spec\nCONSTANTS\n  Msgs = %s\n  MaxText = 1\n  Fixes = {%s}\n  Breaks = {%s}\nINVARIANT TypeOK\nINVARIANT %s\n' \
    "$MSGS" "$fixes" "$breaks" "$invariant" > "$dir/StopSteer.cfg"
  (cd "$dir" && java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers "$workers" -deadlock -cleanup \
    -config StopSteer.cfg -metadir "$dir/meta" StopSteer.tla > "$dir/tlc.log" 2>&1) || true
  if grep -q "No error has been found" "$dir/tlc.log"; then echo pass
  elif grep -q "is violated" "$dir/tlc.log"; then echo fail
  else echo "error (see $dir/tlc.log)"; fi
}

check() {
  local label=$1 invariant=$2 fixes=$3 breaks=$4 expected=$5 workers=$6
  local got
  got=$(tlc "$label-$invariant" "$invariant" "$fixes" "$breaks" "$workers")
  local mark=ok
  [ "$got" = "$expected" ] || { mark=CHANGED; status=1; }
  printf '%-8s %-8s %-22s expected %-5s got %-5s %s\n' "$mark" "$label" "$invariant" "$expected" "$got" "$OUT/$label-$invariant/tlc.log"
}

status=0
mode=${1:-all}
fetch_tlc
case "$mode" in
  all|current|fixed|breaks)
    if [ "$mode" = all ] || [ "$mode" = current ]; then
      for i in "${INVARIANTS[@]}"; do check current "$i" "" "" "${CURRENT[$i]}" 1; done
    fi
    if [ "$mode" = all ] || [ "$mode" = fixed ]; then
      for i in "${INVARIANTS[@]}"; do check fixed "$i" "$FIXES" "" "${FIXED[$i]}" auto; done
    fi
    if [ "$mode" = all ] || [ "$mode" = breaks ]; then
      for b in "${!BREAKS[@]}"; do check "break-$b" "${BREAKS[$b]}" "$FIXES" "\"$b\"" fail 1; done
    fi
    exit $status
    ;;
  one)
    invariant=${2:?usage: run.sh one <Invariant> [current|fixed] [break]}
    fixes=""; [ "${3:-current}" = fixed ] && fixes=$FIXES; [ -n "${FIX_ONLY:-}" ] && fixes=$FIX_ONLY
    breaks=""; [ -n "${4:-}" ] && breaks="\"$4\""
    result=$(tlc one-"$invariant" "$invariant" "$fixes" "$breaks" 1)
    echo "$invariant: $result"
    echo "$OUT/one-$invariant/tlc.log"
    ;;
  *)
    echo "usage: run.sh [all|current|fixed|breaks] | run.sh one <Invariant> [current|fixed] [break]" >&2
    exit 2
    ;;
esac
