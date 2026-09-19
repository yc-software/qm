import { shq } from "../util/shell.ts";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getOperationSignal, withCleanupSignal, withOperationSignal } from "../util/async.ts";
import type { ExecResult } from "./sandbox.ts";

export async function runKillable(
  exec: (script: string, timeoutSec: number) => Promise<ExecResult>,
  script: string,
  timeoutSec: number,
  requestedSignal?: AbortSignal,
  cleanupExec = exec,
): Promise<ExecResult> {
  const ambient = getOperationSignal();
  const signal =
    requestedSignal && ambient ? AbortSignal.any([requestedSignal, ambient]) : (requestedSignal ?? ambient);
  signal?.throwIfAborted();
  if (!signal) return exec(script, timeoutSec);
  const uid = randomUUID();
  const runInContext = AsyncLocalStorage.snapshot();
  let killing: Promise<void> | undefined;
  const kill = () => {
    killing ??= runInContext(() =>
      withCleanupSignal(15000, async () => {
        const result = await cleanupExec(killScript(uid), 15);
        if (result.code !== 0)
          throw new Error(`Remote process cleanup failed: ${result.stderr || result.stdout || result.code}`);
      }),
    );
    void killing.catch(() => undefined);
  };
  signal.addEventListener("abort", kill, { once: true });
  try {
    const result = await withOperationSignal(signal, () => exec(killableScript(script, uid), timeoutSec));
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", kill);
    await killing;
  }
}

export function pgidMarkerPath(uid: string): string {
  return `/tmp/.exec-${uid}.pgid`;
}

export function killableScript(innerScript: string, uid: string): string {
  const marker = shq(pgidMarkerPath(uid));
  const cancelled = shq(`${pgidMarkerPath(uid)}.cancelled`);
  const inner = `echo $$ > ${marker} || exit $?
trap ${shq(`rm -f ${marker} 2>/dev/null`)} 0
if [ -e ${cancelled} ]; then rm -f ${marker} ${cancelled}; exit 130; fi
sh -c ${shq(innerScript)}
__pi_exec_rc=$?
exit $__pi_exec_rc`;
  return `exec setsid --wait sh -c ${shq(inner)}`;
}

export function killScript(uid: string): string {
  const marker = shq(pgidMarkerPath(uid));
  const cancelled = shq(`${pgidMarkerPath(uid)}.cancelled`);
  return `i=0
: > ${cancelled} || exit $?
while [ $i -lt 5 ]; do
  pgid=$(cat ${marker} 2>/dev/null)
  if [ -n "$pgid" ]; then kill -KILL -"$pgid" 2>/dev/null; rm -f ${marker} 2>/dev/null; break; fi
  i=$((i+1))
  sleep 0.1
done`;
}
