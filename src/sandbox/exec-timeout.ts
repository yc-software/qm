import { randomBytes } from "node:crypto";
import { shq } from "../util/shell.ts";

const MARKER_PREFIX = "\n__QM_EXEC_TIMED_OUT_";

/**
 * Wraps `command` so a timeout stops everything it started: TERM to every descendant process (and every
 * process group they lead), then KILL after `graceSec`, including children that ignore TERM or moved to
 * their own session/group (e.g. the abort path's `setsid`). The command runs in the caller's process
 * group, so wrappers that kill by group (abort) keep working. Descendants are found by walking parent
 * pids, so only processes that double-fork away (reparented to init) escape.
 *
 * The watchdog appends a per-exec random marker to stderr when it fired; pass the returned `nonce` to
 * `takeTimeoutMarker`. Command output can't forge it, and exit codes 124/137 are never guessed.
 */
export function withGroupTimeout(command: string, timeoutSec: number, graceSec = 5): { script: string; nonce: string } {
  const nonce = randomBytes(12).toString("hex");
  // Start time (field 22 of /proc/<pid>/stat, read after the parenthesised command name, which may hold
  // spaces). "-" where /proc is unavailable; such entries are killed without the reuse check.
  const st = `__st(){ __s=$(cat /proc/$1/stat 2>/dev/null) || { echo -; return; }; __s=\${__s##*") "}; set -- $__s; shift 19; echo "$1"; }`;
  const tree =
    `__tree(){ ( ps -e -o pid= -o ppid= -o pgid= 2>/dev/null || ` +
    `for s in /proc/[0-9]*/stat; do __l=$(cat "$s" 2>/dev/null) || continue; __r=\${__l##*") "}; set -- $__r; echo "\${s#/proc/}" "$2" "$3"; done | sed 's#/stat##' ) | ` +
    `awk -v root="$1" -v self="$2" '{p[$1]=$2; g[$1]=$3} END{want[root]=1; ch=1; while(ch){ch=0; for(k in p) if(!(k in want) && (p[k] in want)){want[k]=1; ch=1}} ` +
    `for(k in want) if(k in p){print k; if(g[k]!=self && g[k]==k) print "-" k}}'; }`;
  // Targets are snapshotted with their start times at TERM time: once a parent dies its TERM-ignoring
  // children are reparented to init and no longer show up in a fresh walk. A snapshot entry is only
  // signalled while its pid still has the recorded start time, so a pid reused by an unrelated process
  // during the grace period is never hit.
  const snapshot = `for __t in $(__tree $__p $__g); do echo "$__t $(__st \${__t#-})"; done > "$__m"`;
  const killSnap = (sig: string) =>
    `while read __t __st0; do [ "$__st0" = - ] || [ "$(__st \${__t#-})" = "$__st0" ] || continue; kill -${sig} "$__t" 2>/dev/null; done < "$__m"`;
  const killFresh = (sig: string) => `for __t in $(__tree $__p $__g); do kill -${sig} "$__t" 2>/dev/null; done`;
  const script = [
    st,
    tree,
    `__m="/tmp/.qm-to-${nonce}"`,
    `__g=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' '); [ -n "$__g" ] || __g=$(__s=$(cat /proc/$$/stat 2>/dev/null); __s=\${__s##*") "}; set -- $__s; echo "$3")`,
    `sh -c ${shq(command)} &`,
    `__p=$!`,
    `( trap 'kill $__s 2>/dev/null; exit 0' TERM; sleep ${timeoutSec} & __s=$!; wait $__s; kill -0 $__p 2>/dev/null || exit 0; ` +
      `${snapshot}; ${killSnap("TERM")}; sleep ${graceSec} & __s=$!; wait $__s; ${killSnap("KILL")}; ${killFresh("KILL")} ) &`,
    `__w=$!`,
    `wait $__p; __rc=$?`,
    `kill -TERM $__w 2>/dev/null; wait $__w 2>/dev/null`,
    `if [ -e "$__m" ]; then ${killSnap("KILL")}; rm -f "$__m"; printf '%s' ${shq(`${MARKER_PREFIX}${nonce}__\n`)} >&2; fi`,
    `exit $__rc`,
  ].join("\n");
  return { script, nonce };
}

/** Strips this exec's watchdog marker from stderr and reports whether the run timed out. */
export function takeTimeoutMarker(stderr: string, nonce: string): { stderr: string; timedOut: boolean } {
  const marker = `${MARKER_PREFIX}${nonce}__\n`;
  return stderr.endsWith(marker)
    ? { stderr: stderr.slice(0, -marker.length), timedOut: true }
    : { stderr, timedOut: false };
}
