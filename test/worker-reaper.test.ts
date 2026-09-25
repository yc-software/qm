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
import { replayableRequest } from "../src/core/orchestrator/turn-helpers.ts";
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

test("reapExpired fences the dead attempt, releases its session lease, and only then requeues", async () => {
  const { runs } = createMemoryRunStore();
  const r = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const claimed = await runs.claim("dead-worker", 10);
  await sleep(30);

  let statusAtRelease: string | undefined;
  let zombieBeatAtRelease: boolean | undefined;
  let sessionIdsSeen: string[] = [];
  const swept = await runs.reapExpired(async (sessionIds) => {
    sessionIdsSeen = sessionIds;
    statusAtRelease = (await runs.get(r.id))?.status;
    zombieBeatAtRelease = await runs.heartbeat(r.id, claimed!.leaseToken!, 10_000);
  });

  assert.deepEqual(sessionIdsSeen, ["t1"], "the hook receives the retired run's thread ref");
  assert.equal(statusAtRelease, "running", "the lease is released BEFORE the retry becomes claimable");
  assert.equal(zombieBeatAtRelease, false, "the dead attempt is fenced first, so a zombie cannot revive the run");
  assert.equal(swept.requeued, 1);
  assert.equal((await runs.get(r.id))?.status, "pending", "the retry is claimable only after the release hook ran");
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

test("shutdown cancels before handback and holds both leases until the turn unwinds", async () => {
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("t1", "dm", "personal:U1");
  const enq = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 1 })).run;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let unwind!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    unwind = resolve;
  });
  let signal!: AbortSignal;
  let leaseToken!: string;
  const orchestrator = {
    async handleTurn(input: OrchestratorInput) {
      signal = input.cancel!;
      leaseToken = input.runLeaseToken!;
      const { lease } = await sessions.acquireLease(session.id);
      assert.ok(lease);
      started();
      try {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        await cleanup;
        await sessions.append(lease, { type: "system", payload: { kind: "checkpoint" }, scopeLabel: "personal:U1" });
        return { status: "silent" as const, stopped: true };
      } finally {
        await sessions.releaseLease(lease);
      }
    },
  } as unknown as Orchestrator;
  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, heartbeatIntervalMs: 5, pollMs: 5 });
  worker.start();
  await ready;
  await worker.stop(1);
  let released = false;
  const handback = worker.releaseInFlight().then(() => {
    released = true;
  });
  await sleep(20);
  assert.equal(signal.aborted, true, "shutdown reaches the existing cancellation signal immediately");
  assert.equal(released, false, "handback waits for the cancellation checkpoint and finally block");
  assert.equal(worker.busy(), true);
  assert.equal((await runs.get(enq.id))?.status, "running");
  assert.equal(await runs.claim("replacement", 5_000), null);
  assert.equal((await sessions.acquireLease(session.id)).lease, null);
  const second = worker.releaseInFlight();
  unwind();
  await Promise.all([handback, second]);
  assert.equal(worker.busy(), false);
  assert.equal((await runs.get(enq.id))?.status, "pending");
  assert.equal((await runs.get(enq.id))?.errorAttempts, 0);
  const replacement = await runs.claim("replacement", 5_000);
  assert.ok(replacement);
  const freshLease = (await sessions.acquireLease(session.id)).lease;
  assert.ok(freshLease);
  await worker.releaseInFlight();
  assert.equal((await sessions.acquireLease(session.id)).lease, null, "late shutdown cannot steal a new lease");
  assert.equal(await runs.complete(enq.id, leaseToken, { status: "silent" }), false);
  assert.deepEqual(await runs.fail(enq.id, leaseToken, "late error"), { requeued: false });
  assert.equal((await runs.get(enq.id))?.errorAttempts, 0);
});

test("an uncooperative turn keeps both leases until it actually exits", async () => {
  const { runs } = createMemoryRunStore();
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("t1", "dm", "personal:U1");
  const enq = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  let held: Awaited<ReturnType<typeof sessions.acquireLease>>["lease"];
  const { orchestrator, started, unblock } = gatedOrchestrator(
    async () => {
      held = (await sessions.acquireLease(session.id)).lease;
      assert.ok(held);
    },
    async () => {
      await sessions.releaseLease(held!);
    },
  );
  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;
  await worker.stop(1);
  let released = false;
  const handback = worker.releaseInFlight().then(() => {
    released = true;
  });
  await sleep(20);
  assert.equal(released, false);
  assert.equal((await runs.get(enq.id))?.status, "running");
  assert.equal((await sessions.acquireLease(session.id)).lease, null);
  assert.equal(await runs.claim("replacement", 5_000), null);
  unblock();
  await handback;
  assert.equal((await runs.get(enq.id))?.status, "pending");
  assert.equal((await runs.get(enq.id))?.errorAttempts, 0);
  assert.ok((await sessions.acquireLease(session.id)).lease);
});

test("a thrown claim neither kills the worker loop nor blocks the drain handback", async () => {
  const store = createMemoryRunStore();
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

  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;

  const stopping = worker.stop(5_000);
  unblock();
  await stopping;
  assert.equal((await store.runs.get(enq.id))?.status, "done", "the drain still settled the turn");
});

function gatedOrchestrator(
  onStart?: () => Promise<void>,
  onEnd?: () => Promise<void>,
): {
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
      await onEnd?.();
      return { status: "ok", reply: "finished" };
    },
  } as unknown as Orchestrator;
  return { orchestrator, started, unblock };
}

test("stop() lets an in-flight turn finish inside the drain budget — the run completes instead of being handed back", async () => {
  const { runs } = createMemoryRunStore();
  const enq = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const { orchestrator, started, unblock } = gatedOrchestrator();

  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;

  const stopping = worker.stop(5_000);
  unblock();
  await stopping;

  assert.equal((await runs.get(enq.id))?.status, "done", "the turn finished inside the budget");
  await worker.releaseInFlight();
  assert.equal((await runs.get(enq.id))?.status, "done", "nothing left to hand back");
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

test("timed-out stop cannot resurrect a worker while its previous turn drains", async () => {
  const { runs } = createMemoryRunStore();
  const first = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const { orchestrator, started, unblock } = gatedOrchestrator();
  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;
  await worker.stop(5);
  const second = (await runs.enqueue({ sessionId: "t2", request: turn, maxAttempts: 3 })).run;
  worker.start();
  await sleep(30);
  assert.equal((await runs.get(second.id))?.status, "pending");
  unblock();
  await worker.drained();
  assert.equal((await runs.get(first.id))?.status, "done");
  assert.equal((await runs.get(second.id))?.status, "pending");
  worker.start();
  await sleep(30);
  await worker.stop();
  assert.equal((await runs.get(second.id))?.status, "done");
});

test("stopClaims relinquishes new work while keeping an active turn and its heartbeats alive", async () => {
  const { runs } = createMemoryRunStore();
  const first = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const { orchestrator, started, unblock } = gatedOrchestrator();
  let beats = 0;
  const heartbeat = runs.heartbeat.bind(runs);
  runs.heartbeat = (...args) => {
    beats++;
    return heartbeat(...args);
  };
  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, heartbeatIntervalMs: 5, pollMs: 5 });
  worker.start();
  await started;
  await worker.stopClaims();
  let drained = false;
  const draining = worker.drained().then(() => {
    drained = true;
  });
  await sleep(30);
  assert.equal(drained, false);
  assert.ok(beats > 0);
  assert.equal((await runs.get(first.id))?.status, "running");
  unblock();
  await draining;
  assert.equal((await runs.get(first.id))?.status, "done");
});

test("stopClaims waits for an outstanding claim to be handed back before acknowledging", async () => {
  const { runs } = createMemoryRunStore();
  const pending = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const claim = runs.claim.bind(runs);
  const gate = Promise.withResolvers<void>();
  const claiming = Promise.withResolvers<void>();
  runs.claim = async (...args) => {
    claiming.resolve();
    await gate.promise;
    return claim(...args);
  };
  let turns = 0;
  const orchestrator = {
    handleTurn: async () => {
      turns++;
      return { status: "ok", reply: "unexpected" };
    },
  } as unknown as Orchestrator;
  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await claiming.promise;
  let relinquished = false;
  const stopping = worker.stopClaims().then(() => {
    relinquished = true;
  });
  await sleep(10);
  assert.equal(relinquished, false);
  gate.resolve();
  await stopping;
  await worker.drained();
  assert.equal(turns, 0);
  assert.equal((await runs.get(pending.id))?.status, "pending");
});

test("runtime pauses without closing stores and restores worker capacity after a busy rollback", async () => {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "wr-pause-")), workers: 1, leaseTtlMs: 5_000 }),
  );
  const completing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const complete = built.runs.complete.bind(built.runs);
  let first = true;
  built.runs.complete = async (...args) => {
    if (first) {
      first = false;
      completing.resolve();
      await release.promise;
    }
    return complete(...args);
  };
  const enqueue = (threadRef: string) =>
    built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: "hello",
      async: true,
    });
  try {
    const a = await enqueue("pause-first");
    built.runtime.start();
    await completing.promise;
    await built.runtime.stopBackground();
    assert.equal((await built.runs.get(a.runId!))?.status, "running");
    const b = await enqueue("pause-second");
    assert.equal((await built.runs.get(b.runId!))?.status, "pending");
    let drained = false;
    void built.runtime.backgroundDrained().then(() => {
      drained = true;
    });
    await sleep(10);
    assert.equal(drained, false);
    built.runtime.startBackground();
    release.resolve();
    const result = await built.runs.waitFor(b.runId!, 5_000);
    assert.equal(result.status, "done");
    assert.equal(result.attempts, 1);
    await built.runtime.stopBackground();
    await built.runtime.backgroundDrained();
    built.runtime.startBackground();
    const c = await enqueue("pause-third");
    assert.equal((await built.runs.waitFor(c.runId!, 5_000)).status, "done");
  } finally {
    release.resolve();
    await built.runtime.stop();
  }
});

test("inline turns remain admitted through pause and queued intake survives rollback", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "inline-drain-")),
      backgroundDeploymentId: "controlled-test",
      workers: 1,
    }),
  );
  let admitted = true;
  built.runtime.setBackgroundAdmission(() => admitted);
  const completing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const complete = built.runs.complete.bind(built.runs);
  let first = true;
  built.runs.complete = async (...args) => {
    if (first) {
      first = false;
      completing.resolve();
      await release.promise;
    }
    return complete(...args);
  };
  const turn = (threadRef: string, async = false) =>
    built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: "hello",
      async,
    });
  const running = turn("inline-before-pause");
  try {
    await completing.promise;
    admitted = false;
    await built.runtime.stopBackgroundClaims();
    let drained = false;
    const draining = built.runtime.backgroundDrained().then(() => {
      drained = true;
    });
    await sleep(10);
    assert.equal(drained, false);
    assert.equal((await turn("inline-after-pause")).status, "refused");
    const queued = await turn("queued-after-pause", true);
    assert.equal(queued.status, "queued");
    assert.equal((await built.runs.get(queued.runId!))?.status, "pending");
    release.resolve();
    assert.equal((await running).status, "ok");
    await draining;
    admitted = true;
    built.runtime.startBackground();
    assert.equal((await built.runs.waitFor(queued.runId!, 5000)).status, "done");
    assert.equal((await turn("inline-after-resume")).status, "ok");
  } finally {
    release.resolve();
    await running;
    await built.runtime.stop();
  }
});

test("final shutdown waits for an already-started completion instead of releasing its lease", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "bounded-drain-")),
      workers: 1,
      shutdownDrainMs: 30,
    }),
  );
  const completing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const complete = built.runs.complete.bind(built.runs);
  built.runs.complete = async (...args) => {
    completing.resolve();
    await release.promise;
    return complete(...args);
  };
  const queued = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "bounded-worker" },
    text: "hello",
    async: true,
  });
  built.runtime.start();
  try {
    await completing.promise;
    let drained = false;
    const ownershipDrain = built.runtime.backgroundDrained().then(() => {
      drained = true;
    });
    let stopped = false;
    const stopping = built.runtime.stop().then(() => {
      stopped = true;
    });
    await sleep(80);
    assert.equal(stopped, false);
    assert.equal(drained, false);
    assert.equal((await built.runs.get(queued.runId!))?.status, "running");
    release.resolve();
    await Promise.all([stopping, ownershipDrain]);
    assert.equal((await built.runs.get(queued.runId!))?.status, "done");
  } finally {
    release.resolve();
    await built.runtime.backgroundDrained();
  }
});

test("buildApp captures human run outcomes through the shared terminal hook", async (t) => {
  const events: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    events.push(JSON.parse(String(init.body)).event);
    return new Response("ok");
  });
  const built = buildApp(testConfig({ productAnalytics: { apiKey: "test-token" } }));
  try {
    const request: OrchestratorInput = { ...turn, origin: { kind: "human" }, surface: "slack" };
    for (const result of [{ status: "ok" }, { status: "failed" }, { status: "ok", stopped: true }] as const) {
      await built.runs.enqueue({ sessionId: "t1", request });
      const run = (await built.runs.claim("worker", 10_000))!;
      await built.runs.complete(run.id, run.leaseToken!, result);
    }
    assert.deepEqual(events, ["response_completed", "response_failed"]);
  } finally {
    await built.runtime.stop();
  }
});

test("web admission and replay preserve analytics exclusions", async (t) => {
  const events: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    events.push(JSON.parse(String(init.body)).event);
    return new Response("ok");
  });
  const built = buildApp(testConfig({ productAnalytics: { apiKey: "test-token" } }));
  try {
    for (const flag of ["analyticsSuppressed", "proactiveOpener"] as const) {
      for (const status of ["ok", "failed"] as const) {
        const admitted = await built.app.turn({
          surface: "web",
          actor: { externalId: "U1" },
          conversation: { kind: "dm", threadRef: `excluded-${flag}-${status}` },
          text: "test message",
          liveActor: true,
          async: true,
          [flag]: true,
        });
        assert.ok(admitted.runId);
        const run = (await built.runs.claimById(admitted.runId, "worker", 10_000))!;
        assert.equal(run.request[flag], true);
        assert.equal(replayableRequest(run.request)[flag], true);
        await built.runs.complete(run.id, run.leaseToken!, { status });
      }
    }
    assert.deepEqual(events, []);
  } finally {
    await built.runtime.stop();
  }
});
