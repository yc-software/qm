import type { ExecResult } from "../sandbox/sandbox.ts";
import { shq } from "../util/shell.ts";
import { swallow } from "../util/errors.ts";

const EXIT_APP_EXITED = 98;
const EXIT_APP_GONE = 99;
const READY_EXEC_GRACE_SEC = 30;
const APP_PROBE_TIMEOUT_SEC = 5;

type Exec = (script: string, timeoutSec: number) => Promise<Pick<ExecResult, "stdout" | "stderr" | "code">>;

export interface AppReadyOptions {
  appPort: number;
  windowSec: number;
  pidPath: string;
  logPath: string;
}

export const listeningOn = (port: number): string =>
  `listening() { curl -s -o /dev/null --max-time 1 http://127.0.0.1:${port}/; [ "$?" != "7" ]; }`;

const exitedPath = (pidPath: string): string => shq(`${pidPath}.exited`);

export function supervised(inner: string, appPort: number, pidPath: string): string {
  return [
    listeningOn(appPort),
    `rm -f ${exitedPath(pidPath)}`,
    "n=1",
    `while :; do s=$(date +%s); sh -c ${shq(inner)}; rc=$?; echo "$rc" >> ${exitedPath(pidPath)}`,
    'echo "qm: entrypoint exited with status $rc, restarting"',
    "while listening; do sleep 5; done",
    `[ $(( $(date +%s) - s )) -lt 60 ] || n=1; sleep "$n"; [ "$n" -ge 30 ] || n=$((n * 2)); done`,
  ].join("; ");
}

export async function appGone(exec: Exec, opts: { appPort: number; pidPath: string }): Promise<boolean> {
  const probe =
    `${listeningOn(opts.appPort)}; listening && exit 0; pid=$(cat ${shq(opts.pidPath)} 2>/dev/null || true); ` +
    `[ -n "$pid" ] && { kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; } && exit 0; exit ${EXIT_APP_GONE}`;
  const r = await exec(probe, APP_PROBE_TIMEOUT_SEC).catch((e) => {
    swallow("deploy: app liveness probe", e);
    return null;
  });
  return r?.code === EXIT_APP_GONE;
}

export async function waitAppReady(exec: Exec, opts: AppReadyOptions): Promise<void> {
  const probe =
    `pid=$(cat ${shq(opts.pidPath)} 2>/dev/null || true); died=0; ` +
    `end=$(( $(date +%s) + ${opts.windowSec} )); ` +
    `while [ "$(date +%s)" -lt "$end" ]; do ` +
    `curl -s --max-time 2 -o /dev/null http://127.0.0.1:${opts.appPort}/ && exit 0; ` +
    `{ kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; } && [ ! -f ${exitedPath(opts.pidPath)} ] || died=1; ` +
    `sleep 0.5; done; [ "$died" = 1 ] && exit ${EXIT_APP_EXITED}; exit 1`;
  const r = await exec(probe, opts.windowSec + READY_EXEC_GRACE_SEC);
  if (r.code === 0) return;
  const log = await exec(`tail -c 2000 ${shq(opts.logPath)} 2>/dev/null || true`, 30)
    .then((out) => `${out.stdout}${out.stderr}`.trim())
    .catch(() => "");
  const why =
    r.code === EXIT_APP_EXITED
      ? `the version's entrypoint exited without binding port ${opts.appPort}`
      : `app never listened on port ${opts.appPort} within ${opts.windowSec}s`;
  throw new Error(why + (log ? `; last output from the entrypoint:\n${log}` : "; the entrypoint produced no output"));
}
