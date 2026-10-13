import type { ExecResult } from "../sandbox/sandbox.ts";
import { shq } from "../util/shell.ts";
import { swallow } from "../util/errors.ts";
import { redactSecrets } from "../harness/redact-secrets.ts";
import type { Deployment } from "./deploy-store.ts";

const EXIT_APP_SERVER_ERROR = 96;
const EXIT_APP_EXITED = 98;
const EXIT_APP_GONE = 99;
const REPORT_LOG_BYTES = 4000;
const REPORT_CONTEXT_LINES = 40;
const READY_EXEC_GRACE_SEC = 30;
const APP_PROBE_TIMEOUT_SEC = 5;
const EXITED_MARK = "qm: entrypoint exited";

type Exec = (script: string, timeoutSec: number) => Promise<Pick<ExecResult, "stdout" | "stderr" | "code">>;

export type AppErrorSink = (
  e: { category: string; code: string; message: string; scopeLabel: string },
  error?: unknown,
) => void;
type Report = (code: string, detail: string) => Error;

const LITERAL_SECRET_MIN = 8;

export function appReporter(onError: AppErrorSink | undefined, d: Deployment, env?: Record<string, string>): Report {
  const literals = Object.values(env ?? {})
    .filter((v) => v.length >= LITERAL_SECRET_MIN)
    .sort((a, b) => b.length - a.length);
  return (code, detail) => {
    let message = `app ${d.name ?? d.id} (deployment ${d.id}): ${detail}`;
    for (const v of literals) message = message.split(v).join("[redacted]");
    const error = new Error(redactSecrets(message));
    onError?.({ category: "deploy", code, message: error.message, scopeLabel: d.ownerScopeId }, error);
    return error;
  };
}

export interface AppReadyOptions {
  appPort: number;
  windowSec: number;
  pidPath: string;
  logPath: string;
  report?: Report | undefined;
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

export async function appGone(
  exec: Exec,
  opts: { appPort: number; pidPath: string; logPath: string; report?: Report | undefined },
): Promise<boolean> {
  const log = shq(opts.logPath);
  const seen = shq(`${opts.logPath}.reported`);
  const probe = [
    listeningOn(opts.appPort),
    `pid=$(cat ${shq(opts.pidPath)} 2>/dev/null || true)`,
    `s=$(cat ${seen} 2>/dev/null || true)`,
    `if ! listening && ! { [ -n "$pid" ] && { kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; }; }; then ` +
      `[ -n "$pid" ] && [ "$s" != "down $pid" ] && { echo "down $pid" > ${seen}; echo down; tail -c ${REPORT_LOG_BYTES} ${log} 2>/dev/null; }; exit ${EXIT_APP_GONE}; fi`,
    `n=$(wc -l < ${exitedPath(opts.pidPath)} 2>/dev/null || echo 0); r=0`,
    `[ "\${s% *}" = "$pid" ] && r=\${s#* }`,
    `[ "$n" -gt "$r" ] || exit 0`,
    `echo "$pid $n" > ${seen}; echo $((n - r)); grep -F -B ${REPORT_CONTEXT_LINES} ${shq(EXITED_MARK)} ${log} | tail -c ${REPORT_LOG_BYTES}`,
  ].join("; ");
  const r = await exec(probe, APP_PROBE_TIMEOUT_SEC).catch((e) => {
    swallow("deploy: app liveness probe", e);
    return null;
  });
  if (r?.code === EXIT_APP_GONE) {
    const [first, ...tail] = r.stdout.trim().split("\n");
    if (first === "down")
      opts.report?.(
        "app_down",
        `app stopped and nothing restarted it; last output:\n${tail.join("\n").trim() || "(none)"}`,
      );
    return true;
  }
  const out = r?.code === 0 ? r.stdout.trim() : "";
  if (out) {
    const [count, ...rest] = out.split("\n");
    opts.report?.(
      "app_restarted",
      `app exited ${count} time(s) and was restarted; output before exiting:\n${rest.join("\n")}`,
    );
  }
  return false;
}

export async function waitAppReady(exec: Exec, opts: AppReadyOptions): Promise<void> {
  const probe =
    `pid=$(cat ${shq(opts.pidPath)} 2>/dev/null || true); died=0; ` +
    `end=$(( $(date +%s) + ${opts.windowSec} )); ` +
    `while [ "$(date +%s)" -lt "$end" ]; do ` +
    `code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:${opts.appPort}/); ` +
    `[ "$code" != 000 ] && [ "$code" -lt 500 ] && exit 0; ` +
    `{ kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; } && [ ! -f ${exitedPath(opts.pidPath)} ] || died=1; ` +
    `sleep 0.5; done; [ "$died" = 1 ] && exit ${EXIT_APP_EXITED}; ` +
    `[ "$code" -ge 500 ] 2>/dev/null && { echo "$code"; exit ${EXIT_APP_SERVER_ERROR}; }; exit 1`;
  const r = await exec(probe, opts.windowSec + READY_EXEC_GRACE_SEC);
  if (r.code === 0) return;
  const log = await exec(`tail -c 2000 ${shq(opts.logPath)} 2>/dev/null || true`, 30)
    .then((out) => `${out.stdout}${out.stderr}`.trim())
    .catch(() => "");
  let why = `app never listened on port ${opts.appPort} within ${opts.windowSec}s`;
  if (r.code === EXIT_APP_EXITED) why = `the version's entrypoint exited without binding port ${opts.appPort}`;
  if (r.code === EXIT_APP_SERVER_ERROR)
    why = `app answered HTTP ${r.stdout.trim()} on / for the whole ${opts.windowSec}s readiness window`;
  const message = why + (log ? `; last output from the entrypoint:\n${log}` : "; the entrypoint produced no output");
  throw opts.report?.("app_start_failed", message) ?? new Error(message);
}
