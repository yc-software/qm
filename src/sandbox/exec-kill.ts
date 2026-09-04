import { shq } from "../util/shell.ts";

export function pgidMarkerPath(uid: string): string {
  return `/tmp/.exec-${uid}.pgid`;
}

export function killableScript(innerScript: string, uid: string): string {
  const marker = shq(pgidMarkerPath(uid));
  const inner = `echo $$ > ${marker} 2>/dev/null; ${innerScript}
__pi_exec_rc=$?
rm -f ${marker} 2>/dev/null
exit $__pi_exec_rc`;
  return `exec setsid sh -c ${shq(inner)}`;
}

export function killScript(uid: string): string {
  const marker = shq(pgidMarkerPath(uid));
  return `i=0
while [ $i -lt 5 ]; do
  pgid=$(cat ${marker} 2>/dev/null)
  if [ -n "$pgid" ]; then kill -KILL -"$pgid" 2>/dev/null; rm -f ${marker} 2>/dev/null; break; fi
  i=$((i+1))
  sleep 0.1
done`;
}
