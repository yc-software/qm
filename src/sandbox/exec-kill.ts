import { randomUUID } from "node:crypto";
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
  if (Buffer.byteLength(inner, "utf8") <= 64 * 1024) return `exec setsid sh -c ${shq(inner)}`;
  const script = shq(`/tmp/.exec-${uid}.sh`);
  const delimiter = `QM_EXEC_${randomUUID().replaceAll("-", "")}`;
  return `(umask 077; cat > ${script} <<'${delimiter}'
rm -f ${script}
${inner}
${delimiter}
) && exec setsid sh ${script}`;
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
