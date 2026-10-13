import { LRUCache } from "lru-cache";
import type { ExecResult } from "../sandbox/sandbox.ts";
import { shq } from "../util/shell.ts";
import { errMessage, swallow } from "../util/errors.ts";
import { redactSecrets } from "../harness/redact-secrets.ts";
import { createSecretValueMasker } from "../security/secret-masking.ts";
import type { Deployment } from "./deploy-store.ts";

const EXIT_APP_SERVER_ERROR = 96;
const EXIT_APP_EXITED = 98;
const EXIT_APP_GONE = 99;
const REPORT_LOG_BYTES = 4000;
const REPORT_CONTEXT_LINES = 40;
const READY_EXEC_GRACE_SEC = 30;
const APP_PROBE_TIMEOUT_SEC = 5;
const EXITED_MARK = "qm: entrypoint exited";
const APP_CHECK_CACHE_MS = 15_000;
export const APP_PID_PATH = "/tmp/qm-app.pid";
const APP_LOG_PATH = "/tmp/qm-app.log";

export type Exec = (script: string, timeoutSec: number) => Promise<Pick<ExecResult, "stdout" | "stderr" | "code">>;

export type AppErrorSink = (
  e: { category: string; code: string; message: string; scopeLabel: string },
  error?: unknown,
) => void;
type Report = (code: string, detail: string) => Error;

export function appReporter(onError: AppErrorSink | undefined, d: Deployment, env?: Record<string, string>): Report {
  const mask = createSecretValueMasker(env);
  return (code, detail) => {
    const error = new Error(`app ${d.name ?? d.id} (deployment ${d.id}): ${redactSecrets(mask(detail))}`);
    onError?.({ category: "deploy", code, message: error.message, scopeLabel: d.ownerScopeId }, error);
    return error;
  };
}

export interface AppReadyOptions {
  appPort: number;
  windowSec: number;
  report?: Report | undefined;
}

export const listeningOn = (port: number): string =>
  `listening() { curl -s -o /dev/null --max-time 1 http://127.0.0.1:${port}/; c=$?; [ "$c" != 7 ] && [ "$c" != 127 ]; }`;

const EXITED = shq(`${APP_PID_PATH}.exited`);
const REPORTED = shq(`${APP_LOG_PATH}.reported`);

function supervised(inner: string, appPort: number): string {
  return [
    listeningOn(appPort),
    `rm -f ${EXITED} ${REPORTED}`,
    "n=1",
    `while :; do s=$(date +%s); sh -c ${shq(inner)}; rc=$?; echo "$rc" >> ${EXITED}`,
    'echo "qm: entrypoint exited with status $rc, restarting"',
    "while listening; do sleep 5; done",
    `[ $(( $(date +%s) - s )) -lt 60 ] || n=1; sleep "$n"; [ "$n" -ge 30 ] || n=$((n * 2)); done`,
  ].join("; ");
}

export function appLaunch(inner: string, appPort: number): string {
  const launch = `sh -c ${shq(supervised(inner, appPort))} < /dev/null > ${shq(APP_LOG_PATH)} 2>&1 & echo $! > ${shq(APP_PID_PATH)}`;
  return `if command -v setsid >/dev/null 2>&1; then setsid ${launch}; else ${launch}; fi`;
}

export function appBoot(inner: string, appPort: number, prep = "true"): string {
  return [
    `echo $$ > ${APP_PID_PATH}`,
    `if { ${prep}; } > ${shq(APP_LOG_PATH)} 2>&1; then ${appLaunch(inner, appPort)}; fi`,
    `trap 'p=$(cat ${APP_PID_PATH}); kill -TERM -"$p" 2>/dev/null || kill -TERM "$p"; while kill -0 "$p" 2>/dev/null; do sleep 0.2; done; exit 0' INT TERM`,
    "while :; do sleep 3600 & wait $!; done",
  ].join("; ");
}

export const recentAppChecks = (): LRUCache<string, true> => new LRUCache({ max: 500, ttl: APP_CHECK_CACHE_MS });

export async function appLogs(exec: Exec, tailLines: number): Promise<string> {
  const lines = Math.max(1, Math.min(2000, Math.floor(tailLines)));
  return (await exec(`tail -n ${lines} ${shq(APP_LOG_PATH)} 2>/dev/null || true`, 30)).stdout;
}

export async function appGone(exec: Exec, opts: { appPort: number; report?: Report | undefined }): Promise<boolean> {
  const log = shq(APP_LOG_PATH);
  const probe = [
    listeningOn(opts.appPort),
    `pid=$(cat ${shq(APP_PID_PATH)} 2>/dev/null || true)`,
    `s=$(cat ${REPORTED} 2>/dev/null || true)`,
    `if ! listening && ! { [ -n "$pid" ] && { kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; }; }; then ` +
      `[ -n "$pid" ] && [ "$s" != "down $pid" ] && { echo "down $pid" > ${REPORTED}; echo down; tail -c ${REPORT_LOG_BYTES} ${log} 2>/dev/null; }; exit ${EXIT_APP_GONE}; fi`,
    `n=$(wc -l < ${EXITED} 2>/dev/null || echo 0); r=0`,
    `[ "\${s% *}" = "$pid" ] && r=\${s#* }`,
    `[ "$n" -gt "$r" ] || exit 0`,
    `echo "$pid $n" > ${REPORTED}; echo $((n - r)); grep -F -B ${REPORT_CONTEXT_LINES} ${shq(EXITED_MARK)} ${log} | tail -c ${REPORT_LOG_BYTES}`,
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
    `died=0; end=$(( $(date +%s) + ${opts.windowSec} )); ` +
    `while [ "$(date +%s)" -lt "$end" ]; do pid=$(cat ${shq(APP_PID_PATH)} 2>/dev/null || true); ` +
    `code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:${opts.appPort}/); ` +
    `[ "$code" != 000 ] && [ "$code" -lt 500 ] && exit 0; ` +
    `[ -z "$pid" ] || { kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; } && [ ! -f ${EXITED} ] || died=1; ` +
    `sleep 0.5; done; [ "$died" = 1 ] && exit ${EXIT_APP_EXITED}; ` +
    `[ "$code" -ge 500 ] 2>/dev/null && { echo "$code"; exit ${EXIT_APP_SERVER_ERROR}; }; exit 1`;
  const r = await exec(probe, opts.windowSec + READY_EXEC_GRACE_SEC);
  if (r.code === 0) return;
  const log = await exec(`tail -c ${REPORT_LOG_BYTES} ${shq(APP_LOG_PATH)} 2>/dev/null || true`, 30)
    .then((out) => `${out.stdout}${out.stderr}`.trim())
    .catch((e: unknown) => `(the app log could not be read: ${errMessage(e)})`);
  let why = `app never listened on port ${opts.appPort} within ${opts.windowSec}s`;
  if (r.code === EXIT_APP_EXITED) why = `the version's entrypoint exited without binding port ${opts.appPort}`;
  if (r.code === EXIT_APP_SERVER_ERROR)
    why = `app answered HTTP ${r.stdout.trim()} on / for the whole ${opts.windowSec}s readiness window`;
  const message = why + (log ? `; last output from the entrypoint:\n${log}` : "; the entrypoint produced no output");
  throw opts.report?.("app_start_failed", message) ?? new Error(message);
}
