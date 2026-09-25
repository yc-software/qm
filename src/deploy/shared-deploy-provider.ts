import type { ExecResult } from "../sandbox/sandbox.ts";
import { shq } from "../util/shell.ts";
import { bytes, normalizeRelPath, posixJoin, readTree } from "./deploy-fs.ts";

const EXIT_APP_EXITED = 98;
const READY_EXEC_GRACE_SEC = 30;

export interface AppReadyOptions {
  appPort: number;
  windowSec: number;
  pidPath: string;
  logPath: string;
}

export async function waitAppReady(
  exec: (script: string, timeoutSec: number) => Promise<ExecResult>,
  opts: AppReadyOptions,
): Promise<void> {
  const probe =
    `pid=$(cat ${shq(opts.pidPath)} 2>/dev/null || true); died=0; ` +
    `end=$(( $(date +%s) + ${opts.windowSec} )); ` +
    `while [ "$(date +%s)" -lt "$end" ]; do ` +
    `curl -s --max-time 2 -o /dev/null http://127.0.0.1:${opts.appPort}/ && exit 0; ` +
    `kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null || died=1; ` +
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

export async function writeTree(
  write: (absPath: string, data: Uint8Array) => Promise<void>,
  root: string,
  dir: string,
): Promise<void> {
  for (const f of await readTree(dir, { tolerateMissing: true })) {
    await write(posixJoin(root, normalizeRelPath(f.path)), bytes(f.data));
  }
}
