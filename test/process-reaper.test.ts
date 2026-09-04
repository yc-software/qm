import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryProcessRegistry, type ProcessRecord } from "../src/processes/process-registry.ts";
import { createProcessReaper, createReaperKillHook } from "../src/processes/process-reaper.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import type { ProcessSandbox, SandboxHandle, ProvisionOptions, TeardownOptions } from "../src/sandbox/sandbox.ts";
import type { WorkspaceLayer } from "../src/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ID = "00000000-0000-0000-0000-000000000abc";

const FAST_GRACE = { termGraceMs: 20, killGraceMs: 20 };

function killSpySandbox(opts?: { diesOn?: "TERM" | "KILL" | "never"; vanished?: boolean | "string-throw" }) {
  const diesOn = opts?.diesOn ?? "TERM";
  const provisions: Array<{ layers: WorkspaceLayer[]; opts?: ProvisionOptions }> = [];
  const signals: Array<{ processId: string; signal: string }> = [];
  const teardowns: Array<{ opts?: TeardownOptions }> = [];
  const exited = new Set<string>();
  const handle: SandboxHandle = { id: "vm", rootDir: "/workspace" };
  const sandbox = {
    profile: { processSessions: true },
    async provision(layers: WorkspaceLayer[], opts?: ProvisionOptions) {
      provisions.push({ layers, ...(opts ? { opts } : {}) });
      return handle;
    },
    async readProcess(_h: SandboxHandle, processId: string) {
      if (opts?.vanished === "string-throw") throw `no such process session: ${processId}`;
      if (opts?.vanished) throw new Error(`no such process session: ${processId}`);
      return {
        chunks: "",
        cursor: 0,
        status: exited.has(processId) ? { state: "exited", code: 143 } : { state: "running" },
      };
    },
    async signalProcess(_h: SandboxHandle, processId: string, signal: string) {
      signals.push({ processId, signal });
      if (diesOn !== "never" && (signal === diesOn || signal === "KILL")) exited.add(processId);
    },
    async teardown(_h: SandboxHandle, opts?: TeardownOptions) {
      teardowns.push(opts ? { opts } : {});
    },
  } as unknown as ProcessSandbox;
  return { sandbox, provisions, signals, teardowns };
}

const bgId = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;

test("reaper flips expired sessions and calls kill for each", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "build", command: "aws sso login", ttlMs: -1 });
  const killed: string[] = [];
  const reaper = createProcessReaper(reg, {
    intervalMs: 60_000,
    kill: async (r: ProcessRecord) => void killed.push(r.processId),
  });

  const { reaped } = await reaper.sweep();
  assert.equal(reaped, 1);
  assert.deepEqual(killed, [ID]);
  assert.equal((await reg.get(ID))!.status, "reaped");
});

test("reaper calls onReaped for each reaped record (so a reaped run's death can notify the conversation)", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "background", command: "bg: x", ttlMs: -1, runId: "run-7" });
  const seen: Array<{ kind: string; runId?: string }> = [];
  const reaper = createProcessReaper(reg, {
    intervalMs: 60_000,
    onReaped: async (r: ProcessRecord) => void seen.push({ kind: r.kind, ...(r.runId ? { runId: r.runId } : {}) }),
  });

  assert.equal((await reaper.sweep()).reaped, 1);
  assert.deepEqual(
    seen,
    [{ kind: "background", runId: "run-7" }],
    "the reaped record (with its run id) is handed to onReaped",
  );
});

test("a row deleted mid-sweep (a run that finished between snapshot and mark) is neither counted nor notified", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "background", command: "bg: x", ttlMs: -1, runId: "run-9" });
  const notified: string[] = [];
  const reaper = createProcessReaper(reg, {
    intervalMs: 60_000,
    kill: async (r: ProcessRecord) => {
      await reg.delete(r.processId);
    },
    onReaped: async (r: ProcessRecord) => void notified.push(r.processId),
  });
  assert.equal((await reaper.sweep()).reaped, 0, "a row that vanished mid-sweep is not counted as reaped");
  assert.deepEqual(notified, [], "and no false recovery notice fires for a successfully-finished run");
});

test("an onReaped failure does not abort the sweep or un-reap the record", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "background", command: "bg: x", ttlMs: -1, runId: "run-7" });
  const reaper = createProcessReaper(reg, {
    intervalMs: 60_000,
    onReaped: async () => {
      throw new Error("delivery store down");
    },
  });
  assert.equal((await reaper.sweep()).reaped, 1, "the reap still counts despite the hook throwing");
  assert.equal((await reg.get(ID))!.status, "reaped");
});

test("reaper leaves unexpired sessions alone", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "build", command: "make", ttlMs: 60_000 });
  const reaper = createProcessReaper(reg, { intervalMs: 60_000 });
  assert.equal((await reaper.sweep()).reaped, 0);
  assert.equal((await reg.liveByScope("s")).length, 1);
});

test("a kill failure does not abort the sweep, leaves the record running, and is retried next sweep", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: bgId(1), scopeId: "s", kind: "build", command: "x", ttlMs: -1 });
  await reg.register({ processId: bgId(2), scopeId: "s", kind: "background", command: "bg: y", ttlMs: -1 });
  let failFirst = true;
  const reaper = createProcessReaper(reg, {
    intervalMs: 60_000,
    kill: async (r: ProcessRecord) => {
      if (failFirst && r.processId === bgId(1)) throw new Error("boom");
    },
  });

  assert.equal((await reaper.sweep()).reaped, 1, "the other record is still reaped");
  assert.equal((await reg.get(bgId(1)))!.status, "running", "a failed kill is NOT marked dead");
  assert.equal((await reg.get(bgId(2)))!.status, "reaped");

  failFirst = false;
  assert.equal((await reaper.sweep()).reaped, 1, "the failed kill is retried on the next sweep");
  assert.equal((await reg.get(bgId(1)))!.status, "reaped");
});

test("kill hook SIGTERMs every expired kind — background, build, and dev-server alike", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({
    processId: bgId(1),
    scopeId: "personal:A",
    kind: "background",
    command: "bg: npm run build",
    ttlMs: -1,
  });
  await reg.register({ processId: bgId(2), scopeId: "personal:B", kind: "build", command: "aws sso login", ttlMs: -1 });
  await reg.register({
    processId: bgId(3),
    scopeId: "personal:C",
    kind: "dev-server",
    command: "npm run dev",
    ttlMs: -1,
  });

  const { sandbox, provisions, signals, teardowns } = killSpySandbox();
  const reaper = createProcessReaper(reg, { intervalMs: 60_000, kill: createReaperKillHook(sandbox, FAST_GRACE) });

  const { reaped } = await reaper.sweep();
  assert.equal(reaped, 3, "all three rows are reaped (status flipped)");

  assert.deepEqual(
    signals.map((s) => `${s.processId}:${s.signal}`),
    [`${bgId(1)}:TERM`, `${bgId(2)}:TERM`, `${bgId(3)}:TERM`],
    "an abandoned login/auth process is killed at TTL, not just the background kind",
  );

  assert.equal(provisions.length, 3);
  assert.deepEqual(provisions[0]!.layers, [{ scopeId: "personal:A", mode: "rw", mountPath: "" }]);
  assert.equal(provisions[0]!.opts, undefined);
  assert.equal(teardowns.length, 3);
  assert.equal(teardowns[0]!.opts?.keepWarm, true);

  for (const n of [1, 2, 3]) assert.equal((await reg.get(bgId(n)))!.status, "reaped");
});

test("kill hook escalates TERM → KILL when the grace period passes without an exit", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "background", command: "bg: stubborn", ttlMs: -1 });
  const { sandbox, signals } = killSpySandbox({ diesOn: "KILL" });
  const reaper = createProcessReaper(reg, { intervalMs: 60_000, kill: createReaperKillHook(sandbox, FAST_GRACE) });

  assert.equal((await reaper.sweep()).reaped, 1);
  assert.deepEqual(
    signals.map((s) => s.signal),
    ["TERM", "KILL"],
  );
  assert.equal((await reg.get(ID))!.status, "reaped");
});

test("a process that survives TERM+KILL is NOT marked reaped (zombie stays visible, kill retried)", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "background", command: "bg: immortal", ttlMs: -1 });
  const { sandbox, signals } = killSpySandbox({ diesOn: "never" });
  const reaper = createProcessReaper(reg, { intervalMs: 60_000, kill: createReaperKillHook(sandbox, FAST_GRACE) });

  assert.equal((await reaper.sweep()).reaped, 0);
  assert.deepEqual(
    signals.map((s) => s.signal),
    ["TERM", "KILL"],
  );
  assert.equal((await reg.get(ID))!.status, "running", "an unconfirmed kill is not accounted as dead");

  assert.equal((await reaper.sweep()).reaped, 0, "still expired, retried again");
  assert.equal(signals.length, 4);
});

test("only the leader instance's interval sweep reaps (one replica kills, not all of them)", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "background", command: "bg: x", ttlMs: -1 });

  let leader = false;
  const lease: LeaderLease = {
    async hold<T>(_key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      return leader ? fn(new Promise<void>(() => {})) : null;
    },
  };
  const killed: string[] = [];
  const reaper = createProcessReaper(reg, {
    intervalMs: 5,
    kill: async (r: ProcessRecord) => void killed.push(r.processId),
    leaderLease: lease,
  });
  reaper.start();
  try {
    await sleep(40);
    assert.equal((await reg.get(ID))!.status, "running", "a non-leader's interval does not reap");
    assert.equal(killed.length, 0);

    leader = true;
    await sleep(40);
    assert.equal((await reg.get(ID))!.status, "reaped", "the leader's interval reaps the expired process");
    assert.ok(killed.length >= 1);
  } finally {
    reaper.stop();
  }
});

test("a vanished process session counts as a confirmed kill", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "background", command: "bg: x", ttlMs: -1 });
  const { sandbox, teardowns } = killSpySandbox({ vanished: true });
  const reaper = createProcessReaper(reg, { intervalMs: 60_000, kill: createReaperKillHook(sandbox, FAST_GRACE) });

  assert.equal((await reaper.sweep()).reaped, 1);
  assert.equal((await reg.get(ID))!.status, "reaped");
  assert.equal(teardowns[0]!.opts?.keepWarm, true, "the box is still released keep-warm");
});

test("a non-Error 'no such process' rejection also counts as a confirmed kill", async () => {
  const reg = createMemoryProcessRegistry();
  await reg.register({ processId: ID, scopeId: "s", kind: "background", command: "bg: x", ttlMs: -1 });
  const { sandbox } = killSpySandbox({ vanished: "string-throw" });
  const reaper = createProcessReaper(reg, { intervalMs: 60_000, kill: createReaperKillHook(sandbox, FAST_GRACE) });

  assert.equal((await reaper.sweep()).reaped, 1);
  assert.equal((await reg.get(ID))!.status, "reaped");
});
