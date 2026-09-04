import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackgroundBroker } from "../src/connectors/background-exec-broker.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import { redactCommand } from "../src/sandbox/exec-process-session.ts";
import type { ProcessSandbox, ProcessSession, SandboxHandle, StartProcessOptions } from "../src/sandbox/sandbox.ts";

const SCOPE = "personal:U1";
const handle: SandboxHandle = { id: "vm", rootDir: "/workspace", homeDir: "/root" };

function fakeSandbox(opts?: { seedOutput?: string }) {
  interface Proc {
    command: string;
    output: string;
    exited: boolean;
    code: number;
  }
  const procs = new Map<string, Proc>();
  const missing = new Set<string>();
  const starts: Array<{ command: string; opts?: StartProcessOptions }> = [];
  const signals: Array<{ id: string; signal: string }> = [];
  const writes: Array<{ id: string; data: string }> = [];
  const readErrors = new Map<string, unknown>();
  let n = 0;

  const sandbox: ProcessSandbox = {
    profile: {
      backend: "fake",
      writablePersistence: "resident_disk",
      processSessions: true,
    },
    async provision() {
      return handle;
    },
    async run() {
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async writeFileBytes() {},
    async readFileBytes() {
      return null;
    },
    async listDir() {
      return [];
    },
    async removeDir() {},
    async startProcess(_h, command, startOpts?: StartProcessOptions) {
      const processId = `p-${++n}`;
      starts.push({ command, ...(startOpts ? { opts: startOpts } : {}) });
      procs.set(processId, { command, output: opts?.seedOutput ?? "", exited: false, code: 0 });
      return { processId };
    },
    async readProcess(_h, id, opts) {
      if (readErrors.has(id)) {
        const error = readErrors.get(id);
        readErrors.delete(id);
        throw error;
      }
      if (missing.has(id)) throw new Error(`no such process session: ${id}`);
      const p = procs.get(id);
      if (!p) throw new Error(`no such process session: ${id}`);
      const cur = opts?.sinceCursor ?? 0;
      const maxBytes = opts?.maxBytes ?? 64 * 1024;
      const end = Math.min(p.output.length, cur + maxBytes);
      return {
        chunks: p.output.slice(cur, end),
        cursor: end,
        status: p.exited ? { state: "exited", code: p.code } : { state: "running" },
      };
    },
    async writeStdin(_h, id, data) {
      writes.push({ id, data });
    },
    async signalProcess(_h, id, signal) {
      signals.push({ id, signal });
      const p = procs.get(id);
      if (p) {
        p.exited = true;
        p.code = signal === "KILL" ? 137 : 143;
      }
    },
    async listProcesses(): Promise<ProcessSession[]> {
      return [...procs.entries()].map(([processId, p]) => ({
        processId,
        command: p.command,
        startedAt: 0,
        status: p.exited ? { state: "exited", code: p.code } : { state: "running" },
      }));
    },
    async teardown() {},
  };

  return {
    sandbox,
    starts,
    signals,
    writes,
    appendOutput: (id: string, s: string) => {
      const p = procs.get(id);
      if (p) p.output += s;
    },
    finish: (id: string, code = 0) => {
      const p = procs.get(id);
      if (p) {
        p.exited = true;
        p.code = code;
      }
    },
    vanish: (id: string) => missing.add(id),
    failNextRead: (id: string, error: unknown) => readErrors.set(id, error),
  };
}

function build(opts?: { ttlMs?: number; ttlMaxMs?: number; scopeId?: string; seedOutput?: string }) {
  const fake = fakeSandbox(opts?.seedOutput !== undefined ? { seedOutput: opts.seedOutput } : undefined);
  const registry = createMemoryProcessRegistry();
  const broker = createBackgroundBroker({
    sandbox: fake.sandbox,
    registry,
    scopeId: opts?.scopeId ?? SCOPE,
    pollMs: 20,
    ...(opts?.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(opts?.ttlMaxMs !== undefined ? { ttlMaxMs: opts.ttlMaxMs } : {}),
  });
  return { broker, registry, ...fake };
}

test("start registers a REDACTED background row and returns an id + initial output + cursor", async () => {
  const { broker, registry, starts } = build();
  const r = await broker.start(handle, "npm run build");
  assert.equal(r.reattached, false);
  assert.ok(r.processId);
  assert.equal(starts.length, 1);

  const rows = await registry.listByScope(SCOPE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "background");
  assert.equal(rows[0]!.command, redactCommand("bg: npm run build"));
});

test("start does not expose the foreground turn's outbox to a durable background job", async () => {
  const { broker, starts } = build();
  await broker.start({ ...handle, env: { AGENT_OUTBOX: "/workspace/.agent-turn/turn-1/outbox" } }, "long-job");
  assert.deepEqual(starts[0]!.opts?.env, { PYTHONUNBUFFERED: "1" });
});

test("write forwards data to the job's stdin and reports byte count + liveness", async () => {
  const { broker, writes } = build();
  const r = await broker.start(handle, "aws sso login --use-device-code");
  const w = await broker.write(handle, r.processId, "ABCD-1234\n");
  assert.equal(w.processId, r.processId);
  assert.equal(w.bytes, 10);
  assert.equal(w.status.state, "running");
  assert.deepEqual(writes, [{ id: r.processId, data: "ABCD-1234\n" }]);
});

test("write to an unknown / foreign-scope job is rejected", async () => {
  const { broker } = build();
  await assert.rejects(broker.write(handle, "nope", "x"), /no such background job/);
});

test("start surfaces output produced during the brief initial poll (fails if the poll loop is removed)", async () => {
  const { broker, starts } = build({ seedOutput: "hello from the job\n" });
  const r = await broker.start(handle, "echo hi; sleep 5");
  assert.equal(starts.length, 1);
  assert.equal(r.status.state, "running");
  assert.match(r.output, /hello from the job/);
  assert.ok(r.cursor > 0, "the initial poll advanced the cursor past the seeded bytes");
});

test("poll paginates by cursor and a second poll drains the next slice past max_bytes", async () => {
  const { broker, appendOutput } = build();
  const { processId } = await broker.start(handle, "long-job");
  appendOutput(processId, "ABCDEFGHIJ");

  const first = await broker.poll(handle, processId, { sinceCursor: 0, maxBytes: 4 });
  assert.equal(first.chunks, "ABCD");
  assert.equal(first.cursor, 4);
  assert.equal(first.status.state, "running");

  const second = await broker.poll(handle, processId, { sinceCursor: first.cursor, maxBytes: 4 });
  assert.equal(second.chunks, "EFGH");
  assert.equal(second.cursor, 8);

  const third = await broker.poll(handle, processId, { sinceCursor: second.cursor });
  assert.equal(third.chunks, "IJ");
  assert.equal(third.cursor, 10);
});

test("on exit, poll markStatus('exited') but does NOT delete the row (final output stays readable)", async () => {
  const { broker, registry, appendOutput, finish } = build();
  const { processId } = await broker.start(handle, "quick-job");
  appendOutput(processId, "done\n");
  finish(processId, 0);

  const r = await broker.poll(handle, processId, { sinceCursor: 0 });
  assert.equal(r.status.state, "exited");
  const row = await registry.get(processId);
  assert.ok(row);
  assert.equal(row!.status, "exited");
  const again = await broker.poll(handle, processId, { sinceCursor: 0 });
  assert.equal(again.chunks, "done\n");
});

test("stop signals then re-reads status: stopped:true only when the re-read shows exited", async () => {
  const { broker, registry, signals } = build();
  const { processId } = await broker.start(handle, "server");

  const r = await broker.stop(handle, processId);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.signal, "TERM");
  assert.equal(r.stopped, true);
  assert.equal(r.status.state, "exited");
  assert.equal((await registry.get(processId))!.status, "exited");
});

test("stop is idempotent — re-stopping a dead pid is a no-op (still stopped:true)", async () => {
  const { broker } = build();
  const { processId } = await broker.start(handle, "server");
  await broker.stop(handle, processId);
  const again = await broker.stop(handle, processId);
  assert.equal(again.stopped, true);
});

test("stop reports stopped:false while the process is still winding down", async () => {
  const fake = fakeSandbox();
  const registry = createMemoryProcessRegistry();
  const sandbox: ProcessSandbox = { ...fake.sandbox, async signalProcess() {} };
  const broker = createBackgroundBroker({
    sandbox,
    registry,
    scopeId: SCOPE,
    pollMs: 20,
    termGraceMs: 30,
    killGraceMs: 30,
  });
  const { processId } = await broker.start(handle, "stubborn-server");
  const r = await broker.stop(handle, processId);
  assert.equal(r.stopped, false);
  assert.equal(r.status.state, "running");
});

test("stop actually waits the TERM grace: a process exiting shortly after TERM is never KILLed, even with buffered output", async () => {
  const fake = fakeSandbox({ seedOutput: "lots of buffered output\n" });
  const registry = createMemoryProcessRegistry();
  const signals: string[] = [];
  const sandbox: ProcessSandbox = {
    ...fake.sandbox,
    async signalProcess(_h, id, signal) {
      signals.push(signal);
      setTimeout(() => fake.finish(id, 143), 50);
    },
  };
  const broker = createBackgroundBroker({
    sandbox,
    registry,
    scopeId: SCOPE,
    pollMs: 20,
    termGraceMs: 2_000,
    killGraceMs: 100,
  });
  const { processId } = await broker.start(handle, "graceful-server");

  const r = await broker.stop(handle, processId);
  assert.deepEqual(signals, ["TERM"], "the grace period elapsed for real — no instant KILL escalation");
  assert.equal(r.stopped, true);
  assert.equal(r.status.state, "exited");
  assert.equal((await registry.get(processId))!.status, "exited");
});

test("CROSS-SCOPE GUARD: poll/stop of another scope's processId is refused (invariant 1)", async () => {
  const fake = fakeSandbox();
  const registry = createMemoryProcessRegistry();
  const brokerA = createBackgroundBroker({ sandbox: fake.sandbox, registry, scopeId: "personal:A", pollMs: 20 });
  const brokerB = createBackgroundBroker({ sandbox: fake.sandbox, registry, scopeId: "personal:B", pollMs: 20 });

  const { processId } = await brokerA.start(handle, "secret-job");
  await assert.rejects(brokerB.poll(handle, processId), /no such background job/);
  await assert.rejects(brokerB.stop(handle, processId), /no such background job/);
  await assert.rejects(brokerA.poll(handle, "p-does-not-exist"), /no such background job/);
  const ok = await brokerA.poll(handle, processId);
  assert.equal(ok.processId, processId);

  assert.equal((await brokerB.list()).length, 0);
  assert.equal((await brokerA.list()).length, 1);
});

test("reattach by FULL command key: a second start of the same command reattaches to ONE process", async () => {
  const { broker, registry, starts } = build();
  const first = await broker.start(handle, "npm test");
  const second = await broker.start(handle, "npm test");
  assert.equal(starts.length, 1, "no second startProcess");
  assert.equal(second.processId, first.processId);
  assert.equal(second.reattached, true);
  assert.equal((await registry.listByScope(SCOPE)).filter((r) => r.kind === "background").length, 1);
});

test("start does NOT reattach to a matching command whose process has already exited", async () => {
  const { broker, registry, starts, appendOutput, finish } = build();
  const first = await broker.start(handle, "glab auth login --device");
  appendOutput(first.processId, "Waiting for authorization...\nDevice authorization failed\n");
  finish(first.processId, 1);

  const second = await broker.start(handle, "glab auth login --device");
  assert.equal(second.reattached, false, "an expired device-code flow must start fresh");
  assert.notEqual(second.processId, first.processId);
  assert.equal(starts.length, 2);
  assert.equal((await registry.get(first.processId))!.status, "exited");
  assert.equal((await registry.get(second.processId))!.status, "running");
});

test("two commands sharing a long prefix do NOT reattach to each other (Bugbot rule)", async () => {
  const { broker, starts } = build();
  const a = await broker.start(handle, "npm test -- --grep alpha");
  const b = await broker.start(handle, "npm test -- --grep beta");
  assert.notEqual(a.processId, b.processId);
  assert.equal(b.reattached, false);
  assert.equal(starts.length, 2);
});

test("a known injected env value in the command is stored value-masked", async () => {
  const { broker, registry } = build();
  const envHandle: SandboxHandle = { ...handle, env: { GITHUB_TOKEN: "ghp_secretvalue12345" } };
  await broker.start(envHandle, "git clone https://x:ghp_secretvalue12345@github.com/org/repo.git");
  const row = (await registry.listByScope(SCOPE))[0]!;
  assert.ok(!row.command.includes("ghp_secretvalue12345"), `leaked in: ${row.command}`);
  assert.match(row.command, /<redacted:GITHUB_TOKEN>/);
});

test("whitespace is normalized before keying so spacing differences reattach to one job", async () => {
  const { broker, starts } = build();
  const a = await broker.start(handle, "npm   run   build");
  const b = await broker.start(handle, "npm run build");
  assert.equal(a.processId, b.processId);
  assert.equal(starts.length, 1);
});

test("a secret-bearing command is stored REDACTED but does NOT reattach (a redacted key aliases distinct secrets)", async () => {
  const { broker, registry, starts } = build();
  const cmd = "deploy --token sekret123 --target prod";
  await broker.start(handle, cmd);
  const row = (await registry.listByScope(SCOPE))[0]!;
  assert.equal(row.command, redactCommand("bg: deploy --token sekret123 --target prod"));
  assert.match(row.command, /<redacted>/);
  const again = await broker.start(handle, cmd);
  assert.equal(again.reattached, false);
  assert.equal(starts.length, 2);
});

test("two commands differing only in a redacted secret VALUE launch TWO distinct jobs (no alias reattach)", async () => {
  const { broker, starts } = build();
  const a = await broker.start(handle, "deploy --token AAA --target prod");
  const b = await broker.start(handle, "deploy --token BBB --target prod");
  assert.notEqual(a.processId, b.processId);
  assert.equal(b.reattached, false);
  assert.equal(starts.length, 2);
});

test("liveness probe: a row whose backend process is gone is deleted and a fresh process launched", async () => {
  const { broker, registry, starts, vanish } = build();
  const first = await broker.start(handle, "long-build");
  vanish(first.processId);

  const second = await broker.start(handle, "long-build");
  assert.equal(second.reattached, false, "stale row dropped → a fresh launch, not a reattach");
  assert.notEqual(second.processId, first.processId);
  assert.equal(starts.length, 2);
  const rows = (await registry.listByScope(SCOPE)).filter((r) => r.kind === "background");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.processId, second.processId);
});

test("liveness probe: a transient backend error preserves the running process and registry row", async () => {
  const { broker, registry, starts, failNextRead } = build();
  const first = await broker.start(handle, "long-build");
  const error = new Error("backend unavailable");
  failNextRead(first.processId, error);

  await assert.rejects(broker.start(handle, "long-build"), error);
  assert.equal(starts.length, 1);
  assert.equal((await registry.get(first.processId))?.status, "running");
});

test("TTL clamp: a requested lifetime above the max is clamped (mirrors PR C's ceiling clamp)", async () => {
  const ttlMaxMs = 60 * 60_000;
  const { broker, registry } = build({ ttlMs: 30 * 60_000, ttlMaxMs });
  const before = Date.now();
  const r = await broker.start(handle, "huge-job", 10 * 60 * 60_000);
  const row = await registry.get(r.processId);
  assert.ok(row);
  assert.ok(row!.expiresAt <= before + ttlMaxMs + 1000);
  assert.ok(row!.expiresAt >= before + ttlMaxMs - 1000);
});

test("TTL default: omitting a lifetime uses the configured default", async () => {
  const ttlMs = 30 * 60_000;
  const { broker, registry } = build({ ttlMs, ttlMaxMs: 60 * 60_000 });
  const before = Date.now();
  const r = await broker.start(handle, "default-ttl-job");
  const row = await registry.get(r.processId);
  assert.ok(row!.expiresAt >= before + ttlMs - 1000);
  assert.ok(row!.expiresAt <= before + ttlMs + 1000);
});

test("list reports the scope's background jobs from the registry (id, status, startedAt, command)", async () => {
  const { broker, finish } = build();
  const a = await broker.start(handle, "job-a");
  const b = await broker.start(handle, "job-b");
  finish(b.processId, 0);
  await broker.poll(handle, b.processId);

  const jobs = await broker.list();
  assert.equal(jobs.length, 2);
  const byId = new Map(jobs.map((j) => [j.processId, j]));
  assert.equal(byId.get(a.processId)!.status.state, "running");
  assert.equal(byId.get(b.processId)!.status.state, "exited");
  assert.match(byId.get(a.processId)!.command, /job-a/);
});

test("list distinguishes a TTL-reaped row from a clean exit (registry view, not 'exited 0')", async () => {
  const { broker, registry } = build();
  const clean = await broker.start(handle, "clean-job");
  const killed = await broker.start(handle, "ttl-job");
  await registry.markStatus(killed.processId, "reaped");

  const byId = new Map((await broker.list()).map((j) => [j.processId, j]));
  assert.equal(byId.get(clean.processId)!.registryStatus, "running");
  assert.equal(byId.get(killed.processId)!.registryStatus, "reaped");
  const ks = byId.get(killed.processId)!.status;
  assert.equal(ks.state, "exited");
  assert.notEqual(ks.state === "exited" ? ks.code : 0, 0, "a reaped job is NOT surfaced as a clean exit-0");
});

test("start stamps the conversation's sessionRef on the registry row", async () => {
  const fake = fakeSandbox();
  const registry = createMemoryProcessRegistry();
  const broker = createBackgroundBroker({
    sandbox: fake.sandbox,
    registry,
    scopeId: SCOPE,
    sessionRef: "web:U1:thread-9",
    pollMs: 20,
  });
  const { processId } = await broker.start(handle, "sleep 60");
  assert.equal((await registry.get(processId))?.sessionRef, "web:U1:thread-9");

  const bare = createBackgroundBroker({ sandbox: fake.sandbox, registry, scopeId: SCOPE, pollMs: 20 });
  const { processId: p2 } = await bare.start(handle, "sleep 61");
  assert.equal((await registry.get(p2))?.sessionRef, undefined);
});
