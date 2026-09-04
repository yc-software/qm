import { test } from "node:test";
import assert from "node:assert/strict";
import { createMonitorPoller } from "../src/monitors/monitor-poller.ts";
import { createMonitorStore } from "../src/monitors/monitor-store.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";
import type { ProcessSandbox, ProcessSession, SandboxHandle } from "../src/sandbox/sandbox.ts";

const SCOPE = "personal:U1";
const handle: SandboxHandle = { id: "vm", rootDir: "/workspace", homeDir: "/root" };

function fakeSandbox() {
  interface Proc {
    command: string;
    output: string;
    exited: boolean;
    code: number;
  }
  const procs = new Map<string, Proc>();
  const missing = new Set<string>();
  let provisions = 0;
  let teardowns = 0;

  const sandbox: ProcessSandbox = {
    profile: {
      backend: "fake",
      writablePersistence: "resident_disk",
      processSessions: true,
    },
    async provision() {
      provisions++;
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
    async startProcess(_h, command) {
      const processId = `p-${procs.size + 1}`;
      procs.set(processId, { command, output: "", exited: false, code: 0 });
      return { processId };
    },
    async readProcess(_h, id, opts) {
      if (missing.has(id) || !procs.has(id)) throw new Error(`no such process session: ${id}`);
      const p = procs.get(id)!;
      const cur = opts?.sinceCursor ?? 0;
      const end = Math.min(p.output.length, cur + (opts?.maxBytes ?? 64 * 1024));
      return {
        chunks: p.output.slice(cur, end),
        cursor: end,
        status: p.exited ? { state: "exited", code: p.code } : { state: "running" },
      };
    },
    async writeStdin() {},
    async signalProcess() {},
    async listProcesses(): Promise<ProcessSession[]> {
      return [];
    },
    async teardown() {
      teardowns++;
    },
  };

  return {
    sandbox,
    seed: (id: string, command = "bg: npm run build") => procs.set(id, { command, output: "", exited: false, code: 0 }),
    append: (id: string, s: string) => {
      procs.get(id)!.output += s;
    },
    finish: (id: string, code = 0) => {
      const p = procs.get(id)!;
      p.exited = true;
      p.code = code;
    },
    vanish: (id: string) => missing.add(id),
    counts: () => ({ provisions, teardowns }),
  };
}

async function harness(opts?: {
  reply?: string;
  result?: TurnResult;
  leaderLease?: LeaderLease;
  heartbeatMs?: number;
  minFireIntervalMs?: number;
  onRun?: () => Promise<void>;
}) {
  const fake = fakeSandbox();
  const monitors = createMonitorStore();
  const processes = createMemoryProcessRegistry();
  const deliveries = createDeliveryStore();
  const calls: TurnRequest[] = [];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    await opts?.onRun?.();
    return opts?.result ?? { status: "ok", reply: opts?.reply ?? "MONITOR-REPLY" };
  };
  const identity = createIdentityService();
  const poller = createMonitorPoller({
    monitors,
    processes,
    sandbox: fake.sandbox,
    deliveries,
    idempotency: createIdempotencyStore(),
    identity,
    run,
    ...(opts?.leaderLease ? { leaderLease: opts.leaderLease } : {}),
    ...(opts?.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(opts?.minFireIntervalMs !== undefined ? { minFireIntervalMs: opts.minFireIntervalMs } : {}),
  });

  fake.seed("p-1");
  await processes.register({
    processId: "p-1",
    scopeId: SCOPE,
    kind: "background",
    command: "bg: npm run build",
    ttlMs: 600_000,
  });
  const arm = (overrides: Record<string, unknown> = {}) =>
    monitors.create({
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U1") },
      processId: "p-1",
      command: "bg: npm run build",
      threadRef: "thread-1",
      expiresAt: Date.now() + 600_000,
      ...overrides,
    });

  return { ...fake, monitors, processes, deliveries, calls, poller, arm, identity };
}

test("new output wakes the agent as a first-class live turn in the arming conversation", async () => {
  const h = await harness();
  const m = await h.arm();
  h.append("p-1", "compiling...\n");
  await h.poller.tick();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.surface, "monitor");
  assert.equal(h.calls[0]?.conversation.kind, "dm");
  assert.equal(h.calls[0]?.conversation.threadRef, "thread-1");
  assert.match(h.calls[0]?.text ?? "", /compiling\.\.\./);
  assert.match(h.calls[0]?.text ?? "", /watching background job p-1/);
  assert.equal(h.calls[0]?.securityScreenData, "compiling...\n");
  assert.doesNotMatch(h.calls[0]?.securityScreenData ?? "", /Act on this|watching background job/);
  assert.equal(h.calls[0]?.surfaceTools, true);
  assert.equal(h.calls[0]?.addressed, true);
  assert.deepEqual(h.calls[0]?.triggerDestination, {
    type: "slack",
    target: "D1",
    audienceScopeId: scopeId("personal", "U1"),
  });
  assert.equal(
    (await h.deliveries.pending("slack")).length,
    0,
    "no separate poller-side enqueue — the live turn owns delivery",
  );

  const after = await h.monitors.get(m.id);
  assert.equal(after?.cursor, "compiling...\n".length);
  assert.equal(after?.enabled, true);
});

test("no new output means no wake, and already-seen output never refires", async () => {
  const h = await harness();
  await h.arm();
  await h.poller.tick();
  assert.equal(h.calls.length, 0);

  h.append("p-1", "line\n");
  await h.poller.tick();
  await h.poller.tick();
  assert.equal(h.calls.length, 1);
});

test("a crash between fire and cursor-advance refires the same key and is deduped", async () => {
  const h = await harness();
  const m = await h.arm();
  h.append("p-1", "line\n");
  await h.poller.tick();
  await h.monitors.advance(m.id, { cursor: 0 });
  await h.poller.tick();
  assert.equal(h.calls.length, 1);
});

test("pattern: non-matching output advances silently; matching lines wake with only the matches", async () => {
  const h = await harness();
  const m = await h.arm({ pattern: "ERROR|done" });
  h.append("p-1", "step 1 ok\nstep 2 ok\n");
  await h.poller.tick();
  assert.equal(h.calls.length, 0);
  assert.equal((await h.monitors.get(m.id))?.cursor, "step 1 ok\nstep 2 ok\n".length);

  h.append("p-1", "ERROR: build failed\nstep 3 ok\n");
  await h.poller.tick();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]?.text ?? "", /ERROR: build failed/);
  assert.doesNotMatch(h.calls[0]?.text ?? "", /step 3 ok/);
});

test("pattern: a line split across reads is held back and matched whole once completed", async () => {
  const h = await harness();
  const m = await h.arm({ pattern: "ERROR" });
  h.append("p-1", "ERR");
  await h.poller.tick();
  assert.equal(h.calls.length, 0);
  assert.equal((await h.monitors.get(m.id))?.tail, "ERR");

  h.append("p-1", "OR: kaboom\n");
  await h.poller.tick();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]?.text ?? "", /ERROR: kaboom/);
});

test("exit wakes the agent once with the final output, disarms the watch, and marks the registry", async () => {
  const h = await harness();
  const m = await h.arm();
  h.append("p-1", "all done\n");
  h.finish("p-1", 0);
  await h.poller.tick();

  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]?.text ?? "", /exited with code 0/);
  assert.match(h.calls[0]?.text ?? "", /all done/);
  assert.equal((await h.monitors.get(m.id))?.enabled, false);
  assert.equal((await h.processes.get("p-1"))?.status, "exited");

  await h.poller.tick();
  assert.equal(h.calls.length, 1);
});

test("an expired watch reports expiry instead of going silent, then disarms", async () => {
  const h = await harness();
  const m = await h.arm({ expiresAt: 1000 });
  await h.poller.tick(2000);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]?.text ?? "", /watch on it expired/);
  assert.equal((await h.monitors.get(m.id))?.enabled, false);
});

test("a vanished process reports loss instead of going silent, then disarms", async () => {
  const h = await harness();
  const m = await h.arm();
  h.vanish("p-1");
  await h.poller.tick();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]?.text ?? "", /no longer on your computer/);
  assert.equal((await h.monitors.get(m.id))?.enabled, false);
});

test("fire-time authz fails closed: a deactivated owner disarms the watch without running a turn", async () => {
  const h = await harness();
  const m = await h.arm();
  await h.identity.deactivate("U1");
  h.append("p-1", "secret output\n");
  await h.poller.tick();
  assert.equal(h.calls.length, 0);
  assert.equal((await h.monitors.get(m.id))?.enabled, false);
});

test("a wake whose turn didn't complete is reported to the destination, not silently dropped", async () => {
  const h = await harness({ result: { status: "refused", reason: "rate limit exceeded" } });
  const m = await h.arm();
  h.append("p-1", "line\n");
  await h.poller.tick();

  assert.equal(h.calls.length, 1);
  const pending = await h.deliveries.pending("slack");
  assert.match(pending[0]?.text ?? "", /⚠️.*could not run.*rate limit/);
  const after = await h.monitors.get(m.id);
  assert.equal(after?.cursor, "line\n".length);
  assert.equal(after?.enabled, true);
  assert.match(after?.lastError ?? "", /rate limit/);
});

test("a non-leader instance does not poll", async () => {
  const lease: LeaderLease = {
    async hold() {
      return null;
    },
  };
  const h = await harness({ leaderLease: lease });
  await h.arm();
  h.append("p-1", "line\n");
  await h.poller.tick();
  assert.equal(h.calls.length, 0);
});

test("one sandbox handle per scope per tick, torn down keep-warm afterwards", async () => {
  const h = await harness();
  await h.arm();
  await h.arm({ threadRef: "thread-2" });
  h.append("p-1", "line\n");
  await h.poller.tick();
  assert.equal(h.counts().provisions, 1);
  assert.equal(h.counts().teardowns, 1);
  assert.equal(h.calls.length, 2);
});

test("a quiet watch heartbeats so the agent can post a still-running note", async () => {
  const h = await harness({ heartbeatMs: 180_000 });
  const m = await h.arm({ pattern: "^PHASE:" });
  h.append("p-1", "Collecting torch (pip noise)\n");
  await h.poller.tick();
  assert.equal(h.calls.length, 0);

  h.append("p-1", "Installing collected packages\n");
  await h.poller.tick(Date.now() + 200_000);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0]?.text ?? "", /still running/);
  assert.match(h.calls[0]?.text ?? "", /Installing collected packages/);
  const after = await h.monitors.get(m.id);
  assert.equal(after?.enabled, true);
});

test("a heartbeat does not refire within the quiet interval, and re-fires after the next one", async () => {
  const h = await harness({ heartbeatMs: 180_000 });
  await h.arm({ pattern: "^PHASE:" });
  const t0 = Date.now();
  await h.poller.tick(t0 + 200_000);
  assert.equal(h.calls.length, 1);
  await h.poller.tick(t0 + 260_000);
  assert.equal(h.calls.length, 1);
  await h.poller.tick(t0 + 400_000);
  assert.equal(h.calls.length, 2);
});

test("heartbeatMs 0 disables quiet heartbeats", async () => {
  const h = await harness({ heartbeatMs: 0 });
  await h.arm({ pattern: "^PHASE:" });
  await h.poller.tick(Date.now() + 500_000);
  assert.equal(h.calls.length, 0);
});

test("a matching wake resets the heartbeat clock", async () => {
  const h = await harness({ heartbeatMs: 180_000 });
  await h.arm({ pattern: "^PHASE:" });
  const t0 = Date.now();
  h.append("p-1", "PHASE: download\n");
  await h.poller.tick(t0 + 170_000);
  assert.equal(h.calls.length, 1);
  await h.poller.tick(t0 + 200_000);
  assert.equal(h.calls.length, 1);
});

test("output fires are debounced: within the floor nothing refires, and buffered output rides the next fire", async () => {
  const h = await harness({ minFireIntervalMs: 60_000 });
  await h.arm();
  const t0 = Date.now();
  h.append("p-1", "first\n");
  await h.poller.tick(t0);
  assert.equal(h.calls.length, 1);

  h.append("p-1", "second\n");
  await h.poller.tick(t0 + 10_000);
  assert.equal(h.calls.length, 1);

  h.append("p-1", "third\n");
  await h.poller.tick(t0 + 70_000);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1]?.text ?? "", /second/);
  assert.match(h.calls[1]?.text ?? "", /third/);
});

test("exit is never debounced: it fires immediately even inside the floor", async () => {
  const h = await harness({ minFireIntervalMs: 60_000 });
  await h.arm();
  const t0 = Date.now();
  h.append("p-1", "working\n");
  await h.poller.tick(t0);
  assert.equal(h.calls.length, 1);

  h.append("p-1", "done\n");
  h.finish("p-1", 0);
  await h.poller.tick(t0 + 5_000);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1]?.text ?? "", /exited with code 0/);
});

test("an unwatch during the fired turn stops the monitor immediately — no advance, no further wakes", async () => {
  const ref: { monitors?: Awaited<ReturnType<typeof harness>>["monitors"]; victim?: string } = {};
  const h = await harness({
    minFireIntervalMs: 0,
    onRun: async () => {
      if (ref.victim) await ref.monitors?.delete(ref.victim);
    },
  });
  ref.monitors = h.monitors;
  const m = await h.arm();
  ref.victim = m.id;

  h.append("p-1", "output\n");
  await h.poller.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(await h.monitors.get(m.id), null);

  h.append("p-1", "more output\n");
  h.finish("p-1", 0);
  await h.poller.tick();
  await h.poller.tick();
  assert.equal(h.calls.length, 1);
});

test("an unwatch between the tick snapshot and the poll is honored", async () => {
  const ref: {
    monitors?: Awaited<ReturnType<typeof harness>>["monitors"];
    calls?: TurnRequest[];
    byThread?: Record<string, string>;
  } = {};
  const h = await harness({
    minFireIntervalMs: 0,
    onRun: async () => {
      const fired = ref.calls?.at(-1)?.conversation.threadRef;
      const victim = fired === "thread-1" ? ref.byThread?.["thread-2"] : ref.byThread?.["thread-1"];
      if (victim) await ref.monitors?.delete(victim);
    },
  });
  ref.monitors = h.monitors;
  ref.calls = h.calls;
  const a = await h.arm();
  const b = await h.arm({ threadRef: "thread-2" });
  ref.byThread = { "thread-1": a.id, "thread-2": b.id };

  h.append("p-1", "output\n");
  await h.poller.tick();
  assert.equal(h.calls.length, 1);
  const fired = h.calls[0]?.conversation.threadRef === "thread-1" ? a : b;
  const victim = fired === a ? b : a;
  assert.equal((await h.monitors.get(fired.id))?.enabled, true);
  assert.equal(await h.monitors.get(victim.id), null);
});
