import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createReaper } from "../src/runs/reaper.ts";
import { createWorker } from "../src/runs/worker.ts";
import type { Orchestrator } from "../src/core/orchestrator.ts";
import { buildApp } from "../src/wiring.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
};

test("reaper requeues a run whose lease expired (crashed worker)", async () => {
  const { runs } = createMemoryRunStore();
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 })).run;
  await runs.claim("dead-worker", 10);
  await sleep(30);

  const reaper = createReaper(runs, createMemorySessionStore(), { intervalMs: 60_000 });
  const swept = await reaper.sweep();
  assert.equal(swept.requeued, 1);
  assert.equal(swept.parked, 0);
  assert.equal((await runs.get(r.id))?.status, "pending", "expired run is back on the queue");
});

test("a run parks once the ERROR budget (error_attempts) is exhausted", async () => {
  const { runs } = createMemoryRunStore();
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 2 })).run;

  let claimed = await runs.claim("w1", 10_000);
  let failed = await runs.fail(r.id, claimed!.leaseToken!, "boom", { retry: true });
  assert.equal(failed.requeued, true, "first error requeues");
  assert.equal((await runs.get(r.id))?.status, "pending");
  assert.equal((await runs.get(r.id))?.errorAttempts, 1);

  claimed = await runs.claim("w2", 10_000);
  failed = await runs.fail(r.id, claimed!.leaseToken!, "boom again", { retry: true });
  assert.equal(failed.requeued, false, "second error parks");
  const parked = await runs.get(r.id);
  assert.equal(parked?.status, "failed");
  assert.equal(parked?.errorAttempts, 2);
  assert.equal(parked?.attempts, 2, "claim count tracked both claims");
  assert.match(parked?.result?.reason ?? "", /boom again/);
});

test("repeated lease-expiry reaps requeue forever without spending the error budget", async () => {
  const { runs } = createMemoryRunStore();
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 2 })).run;
  const reaper = createReaper(runs, createMemorySessionStore(), { intervalMs: 60_000 });

  for (let i = 0; i < 5; i++) {
    await runs.claim("dead-worker", 10);
    await sleep(20);
    const swept = await reaper.sweep();
    assert.equal(swept.requeued, 1, `reap ${i} requeues`);
    assert.equal(swept.parked, 0, `reap ${i} does not park`);
    const after = await runs.get(r.id);
    assert.equal(after?.status, "pending", "reaped run is always back on the queue");
    assert.equal(after?.errorAttempts, 0, "reaps never spend the error budget");
  }
  assert.equal((await runs.get(r.id))?.attempts, 5);
});

test("with maxClaims set, repeated lease-expiry reaps PARK the poison pill instead of requeuing forever", async () => {
  const { runs } = createMemoryRunStore({ maxClaims: 3 });
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 99 })).run;
  const reaper = createReaper(runs, createMemorySessionStore(), { intervalMs: 60_000 });

  for (let i = 1; i <= 2; i++) {
    await runs.claim("dead-worker", 10);
    await sleep(20);
    const swept = await reaper.sweep();
    assert.deepEqual(swept, { requeued: 1, parked: 0 }, `claim ${i} under the cap requeues`);
    assert.equal((await runs.get(r.id))?.errorAttempts, 0, "a reap never spends the error budget");
  }

  await runs.claim("dead-worker", 10);
  assert.equal((await runs.get(r.id))?.attempts, 3, "third claim reaches the cap");
  await sleep(20);
  const swept = await reaper.sweep();
  assert.deepEqual(swept, { requeued: 0, parked: 1 }, "at the claim cap the poison pill is parked");
  const parked = await runs.get(r.id);
  assert.equal(parked?.status, "failed", "parked run is terminal failed (loud)");
  assert.equal(parked?.errorAttempts, 0, "the claim-cap park did not need the error budget");
  assert.match(parked?.result?.reason ?? "", /suspected crash loop/);
});

test("a concrete error parks with its own message even when over the claim cap", async () => {
  const { runs } = createMemoryRunStore({ maxClaims: 2 });
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 99 })).run;

  let claimed = await runs.claim("w1", 10_000);
  let failed = await runs.fail(r.id, claimed!.leaseToken!, "first boom", { retry: true });
  assert.equal(failed.requeued, true);

  claimed = await runs.claim("w2", 10_000);
  assert.equal(claimed?.attempts, 2, "second claim reaches the cap");
  failed = await runs.fail(r.id, claimed!.leaseToken!, "real boom", { retry: true });
  assert.equal(failed.requeued, false, "over the claim cap, the error parks instead of requeuing");
  const parked = await runs.get(r.id);
  assert.equal(parked?.status, "failed");
  assert.match(parked?.result?.reason ?? "", /real boom/, "the concrete error message is preserved");
  assert.doesNotMatch(parked?.result?.reason ?? "", /crash loop/, "not masked by the crash-loop text");
});

test("only the leader instance's interval sweep reaps expired leases", async () => {
  const { runs } = createMemoryRunStore();
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 })).run;
  await runs.claim("dead-worker", 10);
  await sleep(30);

  let leader = false;
  const lease: LeaderLease = {
    async hold<T>(_key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      return leader ? fn(new Promise<void>(() => {})) : null;
    },
  };
  const reaper = createReaper(runs, createMemorySessionStore(), { intervalMs: 5, leaderLease: lease });
  reaper.start();
  try {
    await sleep(40);
    assert.equal((await runs.get(r.id))?.status, "running", "a non-leader's interval does not reap");

    leader = true;
    await sleep(40);
    assert.equal((await runs.get(r.id))?.status, "pending", "the leader's interval reaps the expired run");
  } finally {
    reaper.stop();
  }
});

test("the reaper's direct sweep() is ungated by the lease (used by tests/tooling)", async () => {
  const { runs } = createMemoryRunStore();
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 })).run;
  await runs.claim("dead-worker", 10);
  await sleep(30);
  const denyAll: LeaderLease = {
    async hold() {
      return null;
    },
  };
  const reaper = createReaper(runs, createMemorySessionStore(), { intervalMs: 60_000, leaderLease: denyAll });
  const swept = await reaper.sweep();
  assert.equal(swept.requeued, 1, "direct sweep() runs regardless of leadership");
  assert.equal((await runs.get(r.id))?.status, "pending");
});

test("reaping a lease-expired run releases its stranded session lease", async () => {
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("t1", "dm", "personal:U1");
  const { lease: held } = await sessions.acquireLease(session.id);
  assert.ok(held, "the (now-dead) worker holds the session lease");
  assert.equal((await sessions.acquireLease(session.id)).lease, null, "session lease is held");

  const r = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  await runs.claim("dead-worker", 10);
  await sleep(30);

  const reaper = createReaper(runs, sessions, { intervalMs: 60_000 });
  const swept = await reaper.sweep();
  assert.equal(swept.requeued, 1);
  assert.equal((await runs.get(r.id))?.status, "pending", "expired run is requeued");
  const { lease: reacquired } = await sessions.acquireLease(session.id);
  assert.ok(reacquired, "session lease was released on reap, so the retry can re-acquire");
});

test("reapExpired retires the run BEFORE releasing its session lease (release only what was retired)", async () => {
  const { runs } = createMemoryRunStore();
  const r = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  await runs.claim("dead-worker", 10);
  await sleep(30);

  let statusAtRelease: string | undefined;
  let sessionIdsSeen: string[] = [];
  const swept = await runs.reapExpired(async (sessionIds) => {
    sessionIdsSeen = sessionIds;
    statusAtRelease = (await runs.get(r.id))?.status;
  });

  assert.deepEqual(sessionIdsSeen, ["t1"], "the hook receives the retired run's thread ref");
  assert.equal(statusAtRelease, "pending", "the run is retired (requeued) before its lease is released");
  assert.equal(swept.requeued, 1);
});

test("a heartbeat landing between SELECT and retire leaves the run AND its session lease untouched", async () => {
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("t1", "dm", "personal:U1");
  const { lease: held } = await sessions.acquireLease(session.id);
  assert.ok(held, "the live worker holds the session lease");

  const r = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const claimed = await runs.claim("live-worker", 10);
  assert.ok(claimed?.leaseToken);
  await sleep(30);

  assert.equal(await runs.heartbeat(r.id, claimed!.leaseToken!, 10_000), true, "live worker renews its lease");

  const reaper = createReaper(runs, sessions, { intervalMs: 60_000 });
  const swept = await reaper.sweep();

  assert.equal(swept.requeued, 0, "the renewed run is not requeued");
  assert.equal(swept.parked, 0, "the renewed run is not parked");
  assert.equal((await runs.get(r.id))?.status, "running", "the run is untouched");
  assert.equal(
    (await sessions.acquireLease(session.id)).lease,
    null,
    "the session lease is untouched — the live worker still holds it",
  );
});

test("draining a worker mid-turn hands back the session write-lock, not just the run lease", async () => {
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("t1", "dm", "personal:U1");
  const enq = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;

  const { orchestrator, started, unblock } = gatedOrchestrator(async () => {
    assert.ok((await sessions.acquireLease(session.id)).lease, "the in-flight turn acquired the session lease");
  });

  const worker = createWorker({ runs, sessions, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;

  await worker.releaseInFlight();

  const { lease: reacquired } = await sessions.acquireLease(session.id);
  assert.ok(reacquired, "drain released the session write-lock so the fresh instance can resume");
  assert.notEqual((await runs.get(enq.id))?.status, "running", "the run was handed back too");

  unblock();
  await worker.stop();
});

test("releaseInFlight is once-per-run — a late duplicate cannot yank a lock the fresh instance re-acquired", async () => {
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("t1", "dm", "personal:U1");
  await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 });
  const { orchestrator, started, unblock } = gatedOrchestrator(async () => {
    assert.ok((await sessions.acquireLease(session.id)).lease);
  });

  const worker = createWorker({ runs, sessions, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;

  const stopping = worker.stop(60_000);
  await worker.releaseInFlight();
  assert.ok((await sessions.acquireLease(session.id)).lease, "the fresh instance re-acquires the session lock");

  await worker.releaseInFlight();
  assert.equal(
    (await sessions.acquireLease(session.id)).lease,
    null,
    "the duplicate release did not strip the fresh instance's lock",
  );

  unblock();
  await stopping;
});

test("a backstop retry still unlocks the session after the first attempt's unlock failed", async () => {
  const { runs } = createMemoryRunStore();
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("t1", "dm", "personal:U1");
  let failUnlocks = 1;
  const sessions = {
    ...store,
    async forceReleaseLease(id: string) {
      if (failUnlocks-- > 0) throw new Error("pg blip");
      return store.forceReleaseLease(id);
    },
  };
  const enq = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const { orchestrator, started, unblock } = gatedOrchestrator(async () => {
    assert.ok((await store.acquireLease(session.id)).lease);
  });

  const worker = createWorker({ runs, sessions, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;

  const stopping = worker.stop(60_000);
  await worker.releaseInFlight();
  assert.equal((await runs.get(enq.id))?.status, "running", "the run is not claimable before its session unlocks");
  assert.equal((await store.acquireLease(session.id)).lease, null, "the session lock is still stranded");

  await worker.releaseInFlight();
  assert.ok((await store.acquireLease(session.id)).lease, "the retry completed the session unlock");
  assert.equal((await runs.get(enq.id))?.status, "pending", "then handed the run back");

  unblock();
  await stopping;
});

test("overlapping releaseInFlight calls collapse into one release (graceful stop vs backstop)", async () => {
  const { runs } = createMemoryRunStore();
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("t1", "dm", "personal:U1");
  let unlockCalls = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const sessions = {
    ...store,
    async forceReleaseLease(id: string) {
      unlockCalls += 1;
      await gate;
      return store.forceReleaseLease(id);
    },
  };
  await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 });
  const { orchestrator, started, unblock } = gatedOrchestrator(async () => {
    assert.ok((await store.acquireLease(session.id)).lease);
  });

  const worker = createWorker({ runs, sessions, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;

  const stopping = worker.stop(60_000);
  const first = worker.releaseInFlight();
  const second = worker.releaseInFlight();
  releaseGate();
  await Promise.all([first, second]);
  assert.equal(unlockCalls, 1, "the overlapping call joined the in-flight release instead of re-running it");

  unblock();
  await stopping;
});

test("a thrown claim neither kills the worker loop nor blocks the drain handback", async () => {
  const store = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  let explode = 2;
  const runs = {
    ...store.runs,
    async claim(workerId: string, ttl: number) {
      if (explode-- > 0) throw new Error("pg down");
      return store.runs.claim(workerId, ttl);
    },
  };
  const enq = (await store.runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const { orchestrator, started, unblock } = gatedOrchestrator();

  const worker = createWorker({ runs, sessions, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;

  const stopping = worker.stop(5_000);
  unblock();
  await stopping;
  assert.equal((await store.runs.get(enq.id))?.status, "done", "the drain still settled the turn");
});

function gatedOrchestrator(onStart?: () => Promise<void>): {
  orchestrator: Orchestrator;
  started: Promise<void>;
  unblock: () => void;
} {
  let unblock: () => void = () => {};
  let signalStarted: () => void = () => {};
  const gate = new Promise<void>((r) => {
    unblock = r;
  });
  const started = new Promise<void>((r) => {
    signalStarted = r;
  });
  const orchestrator = {
    async handleTurn() {
      await onStart?.();
      signalStarted();
      await gate;
      return { status: "ok", reply: "finished" };
    },
  } as unknown as Orchestrator;
  return { orchestrator, started, unblock };
}

test("stop() lets an in-flight turn finish inside the drain budget — the run completes instead of being handed back", async () => {
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  const enq = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const { orchestrator, started, unblock } = gatedOrchestrator();

  const worker = createWorker({ runs, sessions, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;

  const stopping = worker.stop(5_000);
  unblock();
  await stopping;

  assert.equal((await runs.get(enq.id))?.status, "done", "the turn finished inside the budget");
  await worker.releaseInFlight();
  assert.equal((await runs.get(enq.id))?.status, "done", "nothing left to hand back");
});

test("a turn still running past the drain budget is handed back, and its late completion is a no-op", async () => {
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  const enq = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const { orchestrator, started, unblock } = gatedOrchestrator();

  const worker = createWorker({ runs, sessions, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;

  await worker.stop(30);
  assert.equal((await runs.get(enq.id))?.status, "running", "stop() itself never touches the lease");

  await worker.releaseInFlight();
  assert.equal((await runs.get(enq.id))?.status, "pending", "the straggler was handed back to the queue");

  unblock();
  await sleep(30);
  assert.equal((await runs.get(enq.id))?.status, "pending", "the zombie turn's complete() is a token-guarded no-op");
});

test("runtime.stop() drains the in-flight run even with the queue non-empty", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "wr-")),
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  const a = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "t1" },
    text: "first",
    async: true,
  });
  const b = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "t2" },
    text: "second",
    async: true,
  });
  assert.equal(a.status, "queued");
  assert.equal(b.status, "queued");

  built.runtime.start();
  await built.runs.waitFor(a.runId!, 5_000);
  await built.runtime.stop();
  for (const id of [a.runId!, b.runId!]) {
    const status = (await built.runs.get(id))?.status;
    assert.notEqual(status, "running", `run ${id} not abandoned mid-flight (status=${status})`);
  }
  assert.equal((await built.runs.get(a.runId!))?.status, "done", "the drained run finished");
});

test("a worker pool drains a queued run end-to-end", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "wr-")),
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t1" },
      text: "hello",
      async: true,
    });
    assert.equal(ack.status, "queued");
    assert.ok(ack.runId);

    const finished = await built.runs.waitFor(ack.runId!, 5_000);
    assert.equal(finished.status, "done");
    assert.match(finished.result?.reply ?? "", /You said: hello/);
  } finally {
    await built.runtime.stop();
  }
});

test("runtime.start() leaves queued runs idle when background work is disabled", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "wr-")),
      backgroundWorkEnabled: false,
      workers: 1,
      leaseTtlMs: 5_000,
      reaperIntervalMs: 60_000,
    }),
  );
  built.runtime.start();
  try {
    const ack = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "t1" },
      text: "hello",
      async: true,
    });
    assert.equal(ack.status, "queued");
    assert.ok(ack.runId);
    await sleep(50);
    assert.equal((await built.runs.get(ack.runId!))?.status, "pending");
  } finally {
    await built.runtime.stop();
  }
});
