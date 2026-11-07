import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createReaper } from "../src/runs/reaper.ts";
import { createWorker, SHUTDOWN_EXIT_MS, SHUTDOWN_RELEASE_MS, SHUTDOWN_SETTLE_MS } from "../src/runs/worker.ts";
import type { Orchestrator } from "../src/core/orchestrator.ts";
import { buildApp } from "./support/build-app.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import type { BuiltApp } from "../src/wiring.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal } from "../src/types.ts";
import type { RunStore } from "../src/runs/run-store.ts";
import { replayableRequest } from "../src/core/orchestrator/turn-helpers.ts";
import { settle } from "./support/settle.ts";
import { testConfig } from "./support/test-config.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function reopened<T>(databaseUrl: string | undefined, fn: (runs: RunStore) => Promise<T>): Promise<T> {
  const store = createPostgresRunStore(databaseUrl!);
  try {
    return await fn(store.runs);
  } finally {
    await store.close();
  }
}
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
};

test("reaper requeues a run whose lease expired (crashed worker)", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 })).run;
  await runs.claim("dead-worker", 10);
  await sleep(30);

  const reaper = createReaper(runs, {
    ...singleProcessDeps(),
    intervalMs: 60_000,
  });
  const swept = await reaper.sweep();
  assert.equal(swept.requeued, 1);
  assert.equal(swept.parked, 0);
  assert.equal((await runs.get(r.id))?.status, "pending", "expired run is back on the queue");
});

test("a run parks once the ERROR budget (error_attempts) is exhausted", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 2 })).run;

  let claimed = (await runs.claim("w1", 10_000))[0] ?? null;
  let failed = await runs.fail(r.id, claimed!.leaseToken!, "boom", { retry: true });
  assert.equal(failed.requeued, true, "first error requeues");
  assert.equal((await runs.get(r.id))?.status, "pending");
  assert.equal((await runs.get(r.id))?.errorAttempts, 1);

  claimed = (await runs.claim("w2", 10_000))[0] ?? null;
  failed = await runs.fail(r.id, claimed!.leaseToken!, "boom again", { retry: true });
  assert.equal(failed.requeued, false, "second error parks");
  const parked = await runs.get(r.id);
  assert.equal(parked?.status, "failed");
  assert.equal(parked?.errorAttempts, 2);
  assert.equal(parked?.attempts, 2, "claim count tracked both claims");
  assert.match(parked?.result?.reason ?? "", /boom again/);
});

test("repeated lease-expiry reaps requeue forever without spending the error budget", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 2 })).run;
  const reaper = createReaper(runs, {
    ...singleProcessDeps(),
    intervalMs: 60_000,
  });

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
  const { runs } = createPostgresRunStore(testDatabaseUrl(), { maxClaims: 3 });
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 99 })).run;
  const reaper = createReaper(runs, {
    ...singleProcessDeps(),
    intervalMs: 60_000,
  });

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
  const { runs } = createPostgresRunStore(testDatabaseUrl(), { maxClaims: 2 });
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 99 })).run;

  let claimed = (await runs.claim("w1", 10_000))[0] ?? null;
  let failed = await runs.fail(r.id, claimed!.leaseToken!, "first boom", { retry: true });
  assert.equal(failed.requeued, true);

  claimed = (await runs.claim("w2", 10_000))[0] ?? null;
  assert.equal(claimed?.attempts, 2, "second claim reaches the cap");
  failed = await runs.fail(r.id, claimed!.leaseToken!, "real boom", { retry: true });
  assert.equal(failed.requeued, false, "over the claim cap, the error parks instead of requeuing");
  const parked = await runs.get(r.id);
  assert.equal(parked?.status, "failed");
  assert.match(parked?.result?.reason ?? "", /real boom/, "the concrete error message is preserved");
  assert.doesNotMatch(parked?.result?.reason ?? "", /crash loop/, "not masked by the crash-loop text");
});

test("only the leader instance's interval sweep reaps expired leases", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 })).run;
  await runs.claim("dead-worker", 10);
  await sleep(30);

  let leader = false;
  const lease: LeaderLease = {
    async hold<T>(_key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      return leader ? fn(new Promise<void>(() => {})) : null;
    },
  };
  const reaper = createReaper(runs, {
    intervalMs: 5,
    leaderLease: lease,
  });
  reaper.start();
  try {
    await sleep(40);
    assert.equal((await runs.get(r.id))?.status, "running", "a non-leader's interval does not reap");

    leader = true;
    await settle(async () => (await runs.get(r.id))?.status === "pending");
    assert.equal((await runs.get(r.id))?.status, "pending", "the leader's interval reaps the expired run");
  } finally {
    reaper.stop();
  }
});

test("the reaper's direct sweep() is ungated by the lease (used by tests/tooling)", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const r = (await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 })).run;
  await runs.claim("dead-worker", 10);
  await sleep(30);
  const denyAll: LeaderLease = {
    async hold() {
      return null;
    },
  };
  const reaper = createReaper(runs, {
    intervalMs: 60_000,
    leaderLease: denyAll,
  });
  const swept = await reaper.sweep();
  assert.equal(swept.requeued, 1, "direct sweep() runs regardless of leadership");
  assert.equal((await runs.get(r.id))?.status, "pending");
});

test("reapExpired fences the dead attempt before it requeues, so a zombie can neither revive the run nor write", async () => {
  const url = testDatabaseUrl();
  const { runs } = createPostgresRunStore(url);
  const sessions = createPostgresSessionStore(url);
  const session = await sessions.getOrCreateByThread("t1", "dm", "personal:U1");
  const r = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const claimed = (await runs.claim("dead-worker", 10))[0] ?? null;
  await sleep(30);

  const swept = await runs.reapExpired();
  const replacement = await runs.claimById(r.id, "live-worker", 60_000);
  assert.ok(replacement?.leaseToken);

  assert.equal(swept.requeued, 1);
  assert.equal(
    await runs.heartbeat(r.id, claimed!.leaseToken!, 10_000),
    false,
    "the dead attempt is fenced, so a zombie cannot revive the run",
  );
  const entry = (text: string) => ({ kind: "AgentMessage" as const, text });
  await sessions.append({ sessionId: session.id, turnId: r.id, runLeaseToken: replacement.leaseToken }, entry("live"));
  await assert.rejects(
    sessions.append({ sessionId: session.id, turnId: r.id, runLeaseToken: claimed!.leaseToken! }, entry("zombie")),
    /no longer holds its claim/,
  );
  assert.deepEqual(
    (await sessions.getItems(session.id)).map((item) => item.text),
    ["live"],
  );
});

test("a heartbeat landing between SELECT and retire leaves the run untouched", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());

  const r = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const claimed = (await runs.claim("live-worker", 10))[0] ?? null;
  assert.ok(claimed?.leaseToken);
  await sleep(30);

  assert.equal(await runs.heartbeat(r.id, claimed!.leaseToken!, 10_000), true, "live worker renews its lease");

  const reaper = createReaper(runs, { ...singleProcessDeps(), intervalMs: 60_000 });
  const swept = await reaper.sweep();

  assert.equal(swept.requeued, 0, "the renewed run is not requeued");
  assert.equal(swept.parked, 0, "the renewed run is not parked");
  assert.equal((await runs.get(r.id))?.status, "running", "the run is untouched");
});

test("shutdown cancels before handback and holds the run until the turn unwinds", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const sessions = createPostgresSessionStore(testDatabaseUrl());
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
  let shutdownSignal: AbortSignal | undefined;
  let leaseToken!: string;
  const orchestrator = {
    async handleTurn(input: OrchestratorInput) {
      signal = input.cancel!;
      shutdownSignal = input.shutdown;
      leaseToken = input.runLeaseToken!;
      const writer = { sessionId: session.id };
      started();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await cleanup;
      await sessions.append(writer, { kind: "Stop" });
      return { status: "silent" as const, stopped: true };
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
  assert.equal(shutdownSignal?.aborted, true, "the turn can tell this cancellation apart from a user Stop");
  assert.equal(released, false, "handback waits for the cancellation checkpoint and finally block");
  assert.equal((await runs.get(enq.id))?.status, "running");
  assert.equal((await runs.claim("replacement", 5_000))[0] ?? null, null);
  const second = worker.releaseInFlight();
  unwind();
  await Promise.all([handback, second]);
  assert.equal((await runs.get(enq.id))?.status, "pending");
  assert.equal((await runs.get(enq.id))?.errorAttempts, 0);
  const replacement = (await runs.claim("replacement", 5_000))[0] ?? null;
  assert.ok(replacement);
  await worker.releaseInFlight();
  assert.equal((await runs.get(enq.id))?.status, "running", "late shutdown cannot hand back the replacement's claim");
  assert.equal(await runs.complete(enq.id, leaseToken, { status: "silent" }), false);
  assert.deepEqual(await runs.fail(enq.id, leaseToken, "late error"), { requeued: false });
  assert.equal((await runs.get(enq.id))?.errorAttempts, 0);
});

test("an uncooperative turn is handed back after the settle grace, and resumes once after the old process exits", async () => {
  const url = testDatabaseUrl();
  const { runs } = createPostgresRunStore(url);
  const sessions = createPostgresSessionStore(url);
  const session = await sessions.getOrCreateByThread("t1", "dm", "personal:U1");
  const enq = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const attempts: OrchestratorInput[] = [];
  const lateWrite = Promise.withResolvers<unknown>();
  const orchestrator = {
    async handleTurn(input: OrchestratorInput) {
      attempts.push(input);
      if (input.attempt === 1) {
        started.resolve();
        await gate.promise;
        const writer = { sessionId: session.id, turnId: input.runId!, runLeaseToken: input.runLeaseToken! };
        await sessions.append(writer, { kind: "Stop" }).then(lateWrite.resolve, lateWrite.reject);
        return { status: "ok" as const, reply: "stale" };
      }
      return { status: "ok" as const, reply: "resumed" };
    },
  } as unknown as Orchestrator;
  const old = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5, workerId: "old" });
  old.start();
  await started.promise;
  await old.stop(1);
  const shutdownAt = Date.now();
  await Promise.race([
    old.releaseInFlight(),
    sleep(SHUTDOWN_RELEASE_MS).then(() => assert.fail("hand-back waited on the stuck turn")),
  ]);
  assert.ok(Date.now() - shutdownAt >= SHUTDOWN_SETTLE_MS - 50, "the turn gets the settle window first");
  const handedBack = (await runs.get(enq.id))!;
  assert.equal(handedBack.status, "pending");
  assert.equal(handedBack.leaseToken, null);
  assert.equal(handedBack.errorAttempts, 0);
  assert.deepEqual(handedBack.lastStop, { kind: "shutdown" });
  assert.equal(
    (await runs.claim("too-early", 5_000))[0] ?? null,
    null,
    "nothing resumes the turn while the old process may live",
  );
  const staleToken = attempts[0]!.runLeaseToken!;

  gate.resolve();
  await assert.rejects(lateWrite.promise, /no longer holds its claim/);
  assert.equal(await runs.complete(enq.id, staleToken, { status: "ok", sessionId: "t1" }), false);

  const fresh = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5, workerId: "fresh" });
  fresh.start();
  const done = await runs.waitFor(enq.id, 20_000);
  await fresh.stop();
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { status: "ok", reply: "resumed" });
  assert.deepEqual(
    attempts.map((input) => [input.attempt, input.resumeCause]),
    [
      [1, undefined],
      [2, { kind: "shutdown" }],
    ],
  );
  assert.ok(
    Date.now() - shutdownAt >= SHUTDOWN_SETTLE_MS + SHUTDOWN_EXIT_MS,
    "the resume waited for the old process exit",
  );
  assert.equal(
    (await sessions.getItems(session.id)).some((item) => item.kind === "Stop"),
    false,
    "the handed-back attempt cannot write to the conversation",
  );
});

test("shutdown aborts the blocked step before the handback, and the next worker resumes it exactly once", async () => {
  const store = createPostgresRunStore(testDatabaseUrl());
  const events: string[] = [];
  const runs: RunStore = {
    ...store.runs,
    async releaseLease(runId, token) {
      events.push("release");
      return store.runs.releaseLease(runId, token);
    },
  };
  const blocked = Promise.withResolvers<void>();
  const orchestrator = {
    async handleTurn(input: OrchestratorInput) {
      if (input.attempt === 1) {
        events.push("step1");
        blocked.resolve();
        await new Promise<void>((resolve) => input.cancel!.addEventListener("abort", () => resolve(), { once: true }));
        events.push("abort");
        return { status: "silent" as const, stopped: true };
      }
      events.push(`resume@${input.attempt}`);
      events.push("step2");
      return { status: "ok" as const, reply: "finished" };
    },
  } as unknown as Orchestrator;
  const enq = (await store.runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 1 })).run;
  const old = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5, workerId: "old" });
  old.start();
  await blocked.promise;
  await old.stop(1);
  await old.releaseInFlight();
  assert.deepEqual(events, ["step1", "abort", "release"]);
  const handedBack = (await runs.get(enq.id))!;
  assert.equal(handedBack.status, "pending");
  assert.equal(handedBack.errorAttempts, 0);
  assert.equal(handedBack.leaseToken, null);

  const fresh = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5, workerId: "fresh" });
  fresh.start();
  const done = await runs.waitFor(enq.id, 2_000);
  await fresh.stop();
  assert.equal(done.status, "done");
  assert.equal(done.attempts, 2);
  assert.deepEqual(done.result, { status: "ok", reply: "finished" });
  assert.deepEqual(events, ["step1", "abort", "release", "resume@2", "step2"]);
});

test("shutdown mid-turn through the agent leaves no stop marker, and the resumed attempt finishes the work", async () => {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "agent-resume-")), workers: 1, shutdownDrainMs: 30 });
  const agent = createMockAgent();
  const built = buildApp(config, { agent });
  const threadRef = "agent-shutdown-resume";
  const queued = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "!work-until-shutdown",
    async: true,
  });
  const entriesNow = async (app: BuiltApp) => {
    const session = await app.sessions.getByThread(threadRef);
    return session ? app.sessions.getItems(session.id) : [];
  };
  built.runtime.start();
  const deadline = Date.now() + 5_000;
  while (!(await entriesNow(built)).some((entry) => entry.kind === "ToolResult")) {
    if (Date.now() > deadline) throw new Error("the first attempt never recorded its tool work");
    await sleep(10);
  }
  await built.runtime.stop();
  const resumed = buildApp(config, { agent });
  try {
    const handedBack = (await resumed.runs.get(queued.runId!))!;
    assert.equal(handedBack.status, "pending");
    assert.equal(handedBack.attempts, 1);
    assert.equal(handedBack.leaseToken, null);
    const interrupted = await entriesNow(resumed);
    assert.deepEqual(
      interrupted.filter((entry) => entry.kind === "AgentMessage"),
      [],
      "the shutdown-cancelled attempt must not close the turn",
    );
    resumed.runtime.start();
    const done = await resumed.runs.waitFor(queued.runId!, 5_000);
    assert.equal(done.status, "done");
    assert.equal(done.attempts, 2);
    assert.equal(done.result?.reply, "finished after resume");
    const replies = (await entriesNow(resumed)).filter((entry) => entry.kind === "AgentMessage");
    assert.deepEqual(
      replies.map((entry) => entry.text),
      ["finished after resume"],
    );
  } finally {
    await resumed.runtime.stop();
  }
});

test("a thrown claim neither kills the worker loop nor blocks the drain handback", async () => {
  const store = createPostgresRunStore(testDatabaseUrl());
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
  const { runs } = createPostgresRunStore(testDatabaseUrl());
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
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "wr-")),
    workers: 1,
    leaseTtlMs: 5_000,
    reaperIntervalMs: 60_000,
  });
  const built = buildApp(config);
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
  await reopened(config.databaseUrl, async (runs) => {
    for (const id of [a.runId!, b.runId!]) {
      const status = (await runs.get(id))?.status;
      assert.notEqual(status, "running", `run ${id} not abandoned mid-flight (status=${status})`);
    }
    assert.equal((await runs.get(a.runId!))?.status, "done", "the drained run finished");
  });
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

test("a start during a timed-out drain resumes claiming without exceeding the worker's slots", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const first = (await runs.enqueue({ sessionId: "t1", request: turn, maxAttempts: 3 })).run;
  const { orchestrator, started, unblock } = gatedOrchestrator();
  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started;
  await worker.stop(5);
  const second = (await runs.enqueue({ sessionId: "t2", request: turn, maxAttempts: 3 })).run;
  worker.start();
  await sleep(30);
  assert.equal((await runs.get(second.id))?.status, "pending", "the only slot is still busy");
  unblock();
  await runs.waitFor(second.id, 5_000);
  assert.equal((await runs.get(first.id))?.status, "done");
  await worker.stop();
});

test("restarting claims after a stop fills free slots while a held turn keeps running", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const gates = new Map<string, () => void>();
  const orchestrator = {
    handleTurn: (input: { conversation: { threadRef: string } }) =>
      new Promise((resolve) => gates.set(input.conversation.threadRef, () => resolve({ status: "ok", reply: "" }))),
  } as unknown as Orchestrator;
  const enqueue = async (threadRef: string) =>
    (
      await runs.enqueue({
        sessionId: threadRef,
        request: { ...turn, conversation: { ...turn.conversation, threadRef } },
        maxAttempts: 3,
      })
    ).run;
  const long = await enqueue("long");
  const short = await enqueue("short");
  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5, slots: 2 });
  worker.start();
  for (let i = 0; i < 200 && gates.size < 2; i++) await sleep(5);
  await worker.stopClaims();
  worker.start();
  const next = await enqueue("next");
  gates.get("short")!();
  for (let i = 0; i < 200 && !gates.has("next"); i++) await sleep(5);
  assert.ok(gates.has("next"), "the freed slot claims new work");
  assert.equal((await runs.get(long.id))?.status, "running");
  assert.equal((await runs.get(short.id))?.status, "done");
  gates.get("long")!();
  gates.get("next")!();
  await runs.waitFor(next.id, 5_000);
  await worker.stop();
});

test("stopClaims relinquishes new work while keeping an active turn and its heartbeats alive", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
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
  const { runs } = createPostgresRunStore(testDatabaseUrl());
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

test("final shutdown waits for an already-started completion instead of releasing its lease", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "bounded-drain-")),
    workers: 1,
    shutdownDrainMs: 30,
  });
  const built = buildApp(config);
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
    let stopped = false;
    const stopping = built.runtime.stop().then(() => {
      stopped = true;
    });
    await sleep(80);
    assert.equal(stopped, false);
    assert.equal((await built.runs.get(queued.runId!))?.status, "running");
    release.resolve();
    await stopping;
    assert.equal(await reopened(config.databaseUrl, async (runs) => (await runs.get(queued.runId!))?.status), "done");
  } finally {
    release.resolve();
  }
});

test("buildApp captures human run outcomes through the shared terminal hook", async (t) => {
  const events: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    events.push(JSON.parse(String(init.body)).event);
    return new Response("ok");
  });
  const built = buildApp(testConfig({ productAnalytics: { url: "https://events.example.com/ingest" } }));
  try {
    const request: OrchestratorInput = { ...turn, origin: { kind: "human" }, surface: "slack" };
    for (const result of [{ status: "ok" }, { status: "failed" }, { status: "ok", stopped: true }] as const) {
      await built.runs.enqueue({ sessionId: "t1", request });
      const run = ((await built.runs.claim("worker", 10_000))[0] ?? null)!;
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
  const built = buildApp(testConfig({ productAnalytics: { url: "https://events.example.com/ingest" } }));
  try {
    for (const flag of ["analyticsSuppressed", "proactiveOpener"] as const) {
      for (const status of ["ok", "failed"] as const) {
        const admitted = await built.app.turn({
          surface: "web",
          actor: { externalId: "U1" },
          conversation: { kind: "dm", threadRef: `excluded-${flag}-${status}` },
          text: "test message",
          origin: { kind: "human" },
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

test("final shutdown holds a synchronous turn's lease until the step unwinds, then hands the run back", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "inline-shutdown-")),
    workers: 1,
    shutdownDrainMs: 200,
  });
  const built = buildApp(config);
  const blocked = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const append = built.sessions.append.bind(built.sessions);
  let first = true;
  built.sessions.append = async (writer, entry) => {
    if (first && entry.kind === "UserMessage") {
      first = false;
      blocked.resolve();
      await gate.promise;
    }
    return append(writer, entry);
  };
  const inline = built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "inline-shutdown" },
    text: "hello",
  });
  try {
    await blocked.promise;
    const running = (await built.runs.list()).find((run) => run.status === "running")!;
    assert.ok(running);
    let stopped = false;
    const stopping = built.runtime.stop().then(() => {
      stopped = true;
    });
    await sleep(300);
    assert.equal(stopped, false, "stop waits for the running step to unwind");
    assert.equal((await built.runs.get(running.id))?.leaseToken, running.leaseToken);
    assert.equal((await built.runs.claim("replacement", 5_000))[0] ?? null, null);
    gate.resolve();
    const result = await inline;
    await stopping;
    assert.equal(result.status, "queued");
    assert.equal(result.runId, running.id);
    await reopened(config.databaseUrl, async (runs) => {
      const handedBack = (await runs.get(running.id))!;
      assert.equal(handedBack.status, "pending");
      assert.equal(handedBack.leaseToken, null);
      assert.equal(handedBack.errorAttempts, 0);
      assert.equal(handedBack.attempts, 1);
      assert.equal(((await runs.claim("replacement", 5_000))[0] ?? null)?.id, running.id);
    });
  } finally {
    gate.resolve();
    await inline.catch(() => {});
  }
});

test("worker survives sustained claim failures and processes work after recovery", async (t) => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const queued = (await runs.enqueue({ sessionId: "claim-recovery", request: turn })).run;
  const claim = runs.claim.bind(runs);
  let attempts = 0;
  t.mock.method(runs, "claim", async (...args: Parameters<typeof claim>) => {
    attempts++;
    if (attempts <= 25) throw new Error("database unavailable");
    return claim(...args);
  });
  const errors = t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const worker = createWorker({
    runs,
    orchestrator: { handleTurn: async () => ({ status: "silent" }) } as unknown as Orchestrator,
    leaseTtlMs: 5_000,
    pollMs: 1,
  });
  worker.start();
  try {
    const result = await runs.waitFor(queued.id, 5_000);
    assert.equal(result?.status, "done");
    assert.ok(attempts > 25);
    assert.ok(errors.mock.calls.some(({ arguments: args }) => String(args[0]).includes("persistent claim failure")));
  } finally {
    await worker.stopClaims();
    await worker.drained();
  }
});

test("runtime shutdown contains store close failures and waits for remaining stores", async (t) => {
  const built = buildApp(testConfig());
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  built.runs.close = async () => {
    throw new Error("run store disconnect failed");
  };
  built.signals.close = async () => {
    closing.resolve();
    await release.promise;
  };
  const errors = t.mock.method(console, "error", () => {});
  let stopped = false;
  const stopping = built.runtime.stop().then(() => {
    stopped = true;
  });
  try {
    await closing.promise;
    await sleep(10);
    assert.equal(stopped, false);
    release.resolve();
    await stopping;
    assert.ok(errors.mock.calls.some(({ arguments: args }) => String(args[0]).includes("close event stores")));
  } finally {
    release.resolve();
    await stopping;
  }
});

test("a deploy during a park wait stops the turn as a deploy", async () => {
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const enq = (await runs.enqueue({ sessionId: "t-park", request: turn, maxAttempts: 3 })).run;
  const started = Promise.withResolvers<void>();
  const orchestrator = {
    async handleTurn(input: OrchestratorInput) {
      started.resolve();
      await new Promise((resolve) => input.shutdown!.addEventListener("abort", resolve, { once: true }));
      return { status: "silent" as const, sessionId: "t-park", stopped: true };
    },
  } as unknown as Orchestrator;
  const worker = createWorker({ runs, orchestrator, leaseTtlMs: 5_000, pollMs: 5 });
  worker.start();
  await started.promise;
  worker.held()[0]!.parkRequested = true;
  await sleep(50);
  assert.equal((await runs.get(enq.id))!.status, "running", "a park waits for the step to end");
  await worker.stop(1);
  const releasedAt = Date.now();
  await worker.releaseInFlight();
  assert.ok(Date.now() - releasedAt < SHUTDOWN_SETTLE_MS, "the deploy does not wait for the step");
  const handedBack = (await runs.get(enq.id))!;
  assert.equal(handedBack.status, "pending");
  assert.deepEqual(handedBack.lastStop, { kind: "shutdown" });
  assert.equal(handedBack.preemptions, 0);
});
