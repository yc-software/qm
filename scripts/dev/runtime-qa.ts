import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdtempSync, type WriteStream } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { completeDevSecuritySecrets, repoRoot } from "./lib/envctx.ts";
import { signedHeaders } from "../../plugins/chassis/src/core-client.ts";

interface Proc {
  name: string;
  child: ChildProcess;
  lines: string[];
  exited: Promise<number | null>;
}

interface Check {
  scenario: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const SCENARIOS = ["tick", "lease", "crash", "sigterm", "deploy"] as const;
type Scenario = (typeof SCENARIOS)[number];
const LEASE_TTL_MS = 8_000;
const RUN_TIMEOUT_MS = 300_000;
const SLEEP_PROMPT =
  "Run this exact shell command in your sandbox and wait for it to finish: sleep 40; echo runtime-qa-slept. Then reply with exactly: SLEPT";

const root = repoRoot();
const evidence = mkdtempSync(join(tmpdir(), "runtime-qa-"));
const started = Date.now();
const checks: Check[] = [];
const procs = new Map<string, Proc>();
const requested = process.argv.slice(2);
const unknown = requested.filter((s) => !SCENARIOS.includes(s as Scenario));
if (unknown.length) {
  console.error(`runtime-qa: unknown scenario ${unknown.join(", ")} (use: ${SCENARIOS.join(", ")})`);
  process.exit(2);
}
const selected: Scenario[] = requested.length ? (requested as Scenario[]) : [...SCENARIOS];
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("runtime-qa: DATABASE_URL must point at a Postgres server; a throwaway database is created on it");
  process.exit(2);
}
const dbName = `qm_runtime_qa_${Date.now()}`;
const dbUrl = withDatabase(baseUrl, dbName);
const db = new pg.Pool({ connectionString: dbUrl, max: 2 });

function withDatabase(url: string, name: string, app?: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  if (app) parsed.searchParams.set("application_name", app);
  return parsed.toString();
}

function log(msg: string): void {
  const at = new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/Los_Angeles" });
  console.log(`[runtime-qa ${at}] ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(250);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

const sharedEnv = baseEnv();

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  completeDevSecuritySecrets(env, `runtime-qa:${root}`);
  return {
    ...env,
    DATABASE_URL: dbUrl,
    ORG_ID: env.ORG_ID || "acme",
    CORE_ORG_ID: env.ORG_ID || "acme",
    SLACK_BOT_TOKEN: "",
    SLACK_APP_TOKEN: "",
    PUBLIC_WEB_URL: "",
    LEASE_TTL_MS: String(LEASE_TTL_MS),
    SHUTDOWN_DRAIN_MS: "2000",
  };
}

function launch(name: string, entry: string, env: Record<string, string>): Proc {
  const out: WriteStream = createWriteStream(join(evidence, `${name}.log`), { flags: "a" });
  const child = spawn(process.execPath, ["--import", "./scripts/dev/runtime-qa-clock.ts", entry], {
    cwd: root,
    env: { ...sharedEnv, DATABASE_URL: withDatabase(dbUrl, dbName, `runtime-qa-${name}`), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const proc: Proc = {
    name,
    child,
    lines: [],
    exited: new Promise((r) => child.once("exit", (code) => r(code))),
  };
  let partial = "";
  const onData = (chunk: Buffer) => {
    out.write(chunk);
    const parts = (partial + chunk.toString()).split("\n");
    partial = parts.pop() ?? "";
    proc.lines.push(...parts);
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  void proc.exited.then(() => out.end());
  procs.set(name, proc);
  return proc;
}

function seen(proc: Proc, text: string, from = 0): string | undefined {
  return proc.lines.slice(from).find((line) => line.includes(text));
}

async function startWorker(name: string, deployment: string): Promise<Proc> {
  const proc = launch(name, "src/runs/worker-main.ts", {
    BACKGROUND_WORK_ENABLED: "true",
    GIT_SHA: deployment,
    WORKERS: "2",
  });
  await until(`${name} to start draining runs`, () => seen(proc, "[qm:worker] draining runs"), 120_000);
  return proc;
}

async function startCore(): Promise<string> {
  const port = await freePort();
  const proc = launch("core", "src/index.ts", {
    PORT: String(port),
    BACKGROUND_WORK_ENABLED: "false",
  });
  await until("core to listen", () => seen(proc, `listening on :${port}`), 120_000);
  return `http://127.0.0.1:${port}`;
}

async function enqueue(core: string, text: string): Promise<string> {
  const path = "/v1/turns?async=1";
  const body = JSON.stringify({
    surface: "runtime-qa",
    actor: { externalId: "runtime-qa-user" },
    conversation: { kind: "dm", threadRef: `runtime-qa:${randomUUID()}` },
    text,
  });
  const res = await fetch(`${core}${path}`, {
    method: "POST",
    headers: signedHeaders(sharedEnv.CORE_SIGNING_SECRET, "POST", path, body),
    body,
  });
  const queued = (await res.json()) as { runId?: string };
  if (res.status !== 202 || !queued.runId) throw new Error(`enqueue: HTTP ${res.status} ${JSON.stringify(queued)}`);
  return queued.runId;
}

async function runRow(runId: string) {
  const [row] = await query<{ status: string; attempts: number; last_stop: string | null; session_id: string }>(
    "SELECT status, attempts, last_stop, session_id FROM runs WHERE id = $1",
    [runId],
  );
  return row;
}

function claimant(runId: string, from: Map<string, number>): Proc | undefined {
  return [...procs.values()].find((p) => seen(p, `run=${runId}`, from.get(p.name) ?? 0)?.includes("[worker] claimed"));
}

function marks(): Map<string, number> {
  return new Map([...procs.values()].map((p) => [p.name, p.lines.length]));
}

async function sandboxCommandStarted(sessionId: string): Promise<boolean | undefined> {
  const rows = await query(
    "SELECT 1 FROM items WHERE session_id = $1 AND kind = 'ToolCall' AND body::text LIKE '%runtime-qa-slept%' LIMIT 1",
    [sessionId],
  );
  return rows.length > 0 || undefined;
}

async function finished(runId: string): Promise<string> {
  return until(
    `run ${runId} to finish`,
    async () => {
      const row = await runRow(runId);
      return row && ["done", "failed"].includes(row.status) ? row.status : undefined;
    },
    RUN_TIMEOUT_MS,
  );
}

async function lockHolder(key: string): Promise<string | undefined> {
  const [row] = await query<{ application_name: string }>(
    `SELECT a.application_name FROM pg_locks l JOIN pg_stat_activity a USING (pid)
      WHERE l.locktype = 'advisory' AND l.granted
        AND l.classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
        AND l.objid = (hashtextextended($1, 0) & 4294967295)::oid`,
    [`leader-lease:${key}`],
  );
  return row?.application_name.replace("runtime-qa-", "");
}

async function check(scenario: string, body: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  log(`${scenario}: start`);
  try {
    const detail = await body();
    checks.push({ scenario, ok: true, detail, ms: Date.now() - t0 });
    log(`${scenario}: PASS ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    checks.push({ scenario, ok: false, detail, ms: Date.now() - t0 });
    log(`${scenario}: FAIL ${detail}`);
  }
}

function signal(proc: Proc, sig: NodeJS.Signals): void {
  if (!proc.child.kill(sig)) throw new Error(`could not send ${sig} to ${proc.name}`);
}

function other(proc: Proc): Proc {
  return procs.get(proc.name === "worker-a" ? "worker-b" : "worker-a")!;
}

async function heartbeatAt(deployment: string): Promise<number> {
  const [row] = await query<{ at: string }>(
    "SELECT extract(epoch FROM max(beat_at)) * 1000 AS at FROM instance_heartbeats WHERE build_sha = $1",
    [deployment],
  );
  return Number(row?.at ?? 0);
}

async function scenarioTick(): Promise<string> {
  const a = procs.get("worker-a")!;
  await sleep(1_500);
  const before = await heartbeatAt("runtime-qa-1");
  const from = a.lines.length;
  const sent = Date.now();
  signal(a, "SIGUSR2");
  const ticked = await until("tick acknowledgement", () => seen(a, "SIGUSR2 ticked", from), 5_000);
  await until("a fresh deploy-drain heartbeat", async () => (await heartbeatAt("runtime-qa-1")) > before || undefined, 3_000);
  return `${ticked.trim()}; drain heartbeat refreshed ${Date.now() - sent} ms after the signal (interval 10 s)`;
}

async function scenarioLease(): Promise<string> {
  const key = "cron:scheduler:tick";
  const first = await until(`a holder of ${key}`, () => lockHolder(key), 20_000);
  const holder = procs.get(first);
  if (!holder) throw new Error(`${key} is held by ${first || "an unnamed connection"}, not a QA worker`);
  const killedAt = Date.now();
  signal(holder, "SIGKILL");
  await holder.exited;
  const next = await until(
    `${key} to move off ${first}`,
    async () => {
      const now = await lockHolder(key);
      return now && now !== first ? now : undefined;
    },
    15_000,
  );
  const handoverMs = Date.now() - killedAt;
  await startWorker(first, "runtime-qa-1");
  return `${key} moved ${first} -> ${next} ${handoverMs} ms after SIGKILL; ${first} restarted`;
}

async function sleepingRun(core: string): Promise<{ runId: string; worker: Proc; sessionId: string }> {
  const from = marks();
  const runId = await enqueue(core, SLEEP_PROMPT);
  const worker = await until(`a worker to claim ${runId}`, () => claimant(runId, from), 60_000);
  const sessionId = (await runRow(runId))!.session_id;
  await until(`the sandbox command in ${runId}`, () => sandboxCommandStarted(sessionId), 180_000);
  return { runId, worker, sessionId };
}

async function scenarioCrash(core: string): Promise<string> {
  const { runId, worker } = await sleepingRun(core);
  const survivor = other(worker);
  const from = marks();
  signal(worker, "SIGKILL");
  await worker.exited;
  await sleep(LEASE_TTL_MS + 500);
  signal(survivor, "SIGUSR2");
  const reclaimer = await until(`the reaper to requeue ${runId}`, () => claimant(runId, from), 8_000);
  if (reclaimer.name !== survivor.name) throw new Error(`${runId} reclaimed by ${reclaimer.name}`);
  const status = await finished(runId);
  const row = (await runRow(runId))!;
  await startWorker(worker.name, "runtime-qa-1");
  if (status !== "done") throw new Error(`${runId} ended ${status} after handover`);
  return `${runId}: ${worker.name} SIGKILLed mid-command, forced reaper tick requeued it, ${survivor.name} resumed it to done (attempts=${row.attempts})`;
}

async function scenarioSigterm(core: string): Promise<string> {
  const { runId, worker } = await sleepingRun(core);
  const survivor = other(worker);
  const from = marks();
  const sentAt = Date.now();
  signal(worker, "SIGTERM");
  const code = await worker.exited;
  const exitMs = Date.now() - sentAt;
  if (!seen(worker, "SIGTERM received", from.get(worker.name))) throw new Error(`${worker.name} never logged SIGTERM`);
  const handed = (await runRow(runId))!;
  const reclaimer = await until(`${survivor.name} to claim ${runId}`, () => claimant(runId, from), LEASE_TTL_MS);
  const reclaimMs = Date.now() - sentAt;
  const status = await finished(runId);
  await startWorker(worker.name, "runtime-qa-1");
  if (status !== "done") throw new Error(`${runId} ended ${status} after hand-back`);
  return `${runId}: ${worker.name} exited ${code} ${exitMs} ms after SIGTERM (last_stop=${handed.last_stop}), ${reclaimer.name} reclaimed in ${reclaimMs} ms without the reaper and finished it`;
}

async function scenarioDeploy(core: string): Promise<string> {
  const from = marks();
  const next = launch("worker-c", "src/runs/worker-main.ts", {
    BACKGROUND_WORK_ENABLED: "true",
    GIT_SHA: "runtime-qa-2",
    WORKERS: "2",
  });
  await until("worker-c to boot", () => seen(next, "[qm:worker] draining runs"), 120_000);
  const old = [procs.get("worker-a")!, procs.get("worker-b")!];
  for (const p of old) signal(p, "SIGUSR2");
  for (const p of old) await until(`${p.name} to drain`, () => seen(p, "newer build is live", from.get(p.name)), 5_000);
  const runId = await enqueue(core, "Reply with exactly: PONG");
  const worker = await until(`a worker to claim ${runId}`, () => claimant(runId, from), 30_000);
  if (worker.name !== "worker-c") throw new Error(`${runId} claimed by ${worker.name}, an older build`);
  const status = await finished(runId);
  if (status !== "done") throw new Error(`${runId} ended ${status}`);
  return `newer build worker-c took over: worker-a and worker-b drained on a forced tick, ${runId} ran on worker-c`;
}

async function teardown(): Promise<void> {
  for (const p of procs.values()) if (p.child.exitCode === null) p.child.kill("SIGTERM");
  await Promise.race([Promise.all([...procs.values()].map((p) => p.exited)), sleep(20_000)]);
  for (const p of procs.values()) if (p.child.exitCode === null) p.child.kill("SIGKILL");
  await db.end();
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
}

async function main(): Promise<void> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  log(`database ${dbName}; logs in ${evidence}`);
  const core = await startCore();
  await startWorker("worker-a", "runtime-qa-1");
  await startWorker("worker-b", "runtime-qa-1");
  log(`booted core + 2 workers in ${Date.now() - started} ms`);
  const runs: Record<Scenario, () => Promise<string>> = {
    tick: scenarioTick,
    lease: scenarioLease,
    crash: () => scenarioCrash(core),
    sigterm: () => scenarioSigterm(core),
    deploy: () => scenarioDeploy(core),
  };
  for (const s of selected) await check(s, runs[s]);
}

try {
  await main();
} catch (e) {
  checks.push({ scenario: "boot", ok: false, detail: e instanceof Error ? e.message : String(e), ms: 0 });
  log(`boot: FAIL ${checks.at(-1)!.detail}`);
} finally {
  await teardown();
}
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.scenario} (${Math.round(c.ms / 1000)} s): ${c.detail}`);
console.log(`runtime-qa: ${checks.length - failed.length}/${checks.length} passed in ${Math.round((Date.now() - started) / 1000)} s; logs in ${evidence}`);
process.exit(failed.length ? 1 : 0);
