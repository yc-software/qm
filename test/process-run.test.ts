import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { processRun, LEASE_LOST_CONSECUTIVE } from "../src/runs/worker.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import type { RunStore } from "../src/runs/run-store.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Principal, TurnResult } from "../src/types.ts";

const actor: Principal = { id: "internal:U1", type: "internal" };
const turn: OrchestratorInput = {
  actor,
  conversation: { kind: "dm", threadRef: "t1", audience: [actor] },
  origin: { kind: "direct" },
  text: "x",
};

function fakeOrchestrator(handle: (input: OrchestratorInput) => Promise<TurnResult>): Orchestrator {
  return {
    handleTurn: handle,
    async screenSecuritySteer() {
      return "allow";
    },
    async regenerateTitle() {
      return null;
    },
  };
}

function spyHeartbeats(runs: RunStore): {
  runs: RunStore;
  beats: Array<{ runId: string; token: string; ttl: number; ok: boolean }>;
} {
  const beats: Array<{ runId: string; token: string; ttl: number; ok: boolean }> = [];
  return {
    beats,
    runs: {
      ...runs,
      async heartbeat(runId, token, ttl) {
        const ok = await runs.heartbeat(runId, token, ttl);
        beats.push({ runId, token, ttl, ok });
        return ok;
      },
    },
  };
}

const microtasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("processRun refuses a run that holds no lease", async () => {
  const { runs } = createMemoryRunStore();
  const r = (await runs.enqueue({ sessionId: "s1", request: turn })).run;
  const orchestrator = fakeOrchestrator(async () => {
    throw new Error("must not be reached");
  });
  await assert.rejects(processRun({ runs, orchestrator, leaseTtlMs: 5_000 }, r), /unleased/);
  assert.equal((await runs.get(r.id))?.status, "pending", "the run was not touched");
});

test("processRun threads runId + background into the turn and completes the run with the result", async () => {
  const { runs } = createMemoryRunStore();
  const seen: OrchestratorInput[] = [];
  const orchestrator = fakeOrchestrator(async (input) => {
    seen.push(input);
    return { status: "ok", reply: `echo: ${input.text}` };
  });
  const deps = { runs, orchestrator, leaseTtlMs: 5_000 };

  await runs.enqueue({ sessionId: "s1", request: turn });
  const fg = await runs.claim("w1", 5_000);
  const result = await processRun(deps, fg!);
  assert.deepEqual(result, { status: "ok", reply: "echo: x" });
  assert.equal(seen[0]?.runId, fg!.id, "the orchestrator sees the run's id");
  assert.equal(seen[0]?.background, false, "foreground by default");
  assert.equal(seen[0]?.attempt, 1, "the orchestrator sees which claim this is");

  const done = await runs.get(fg!.id);
  assert.equal(done?.status, "done");
  assert.deepEqual(done?.result, { status: "ok", reply: "echo: x" });
  assert.equal(done?.leaseToken, null, "the lease is released on completion");

  await runs.enqueue({ sessionId: "s2", request: turn });
  const bg = await runs.claim("w1", 5_000);
  await processRun(deps, bg!, { background: true });
  assert.equal(seen[1]?.background, true, "the worker-loop flag reaches the orchestrator");
});

test("processRun rejects when a reaped attempt finishes after a retry claims the run", async () => {
  const { runs } = createMemoryRunStore();
  let finish = (_: TurnResult) => {};
  const turnResult = new Promise<TurnResult>((resolve) => {
    finish = resolve;
  });
  const orchestrator = fakeOrchestrator(() => turnResult);

  await runs.enqueue({ sessionId: "s1", request: turn });
  const first = await runs.claim("w1", -1);
  const pending = processRun({ runs, orchestrator, leaseTtlMs: 5_000 }, first!);

  assert.deepEqual(await runs.reapExpired(), { requeued: 1, parked: 0 });
  const second = await runs.claim("w2", 5_000);
  assert.equal(second?.attempts, 2);

  finish({ status: "ok", reply: "stale" });
  await assert.rejects(pending, /lost.*lease/i);

  const current = await runs.get(first!.id);
  assert.equal(current?.status, "running");
  assert.equal(current?.leaseToken, second?.leaseToken);
  assert.equal(current?.result, null);
});

test("processRun upgrades legacy queued provenance before orchestration", async () => {
  const { runs } = createMemoryRunStore();
  const legacy = { ...turn, origin: undefined, liveActor: true, triggerTs: "1" } as unknown as OrchestratorInput;
  await runs.enqueue({ sessionId: "legacy", request: legacy });
  const claimed = await runs.claim("w1", 5_000);
  let seen: OrchestratorInput | undefined;
  await processRun(
    {
      runs,
      orchestrator: fakeOrchestrator(async (input) => {
        seen = input;
        return { status: "ok" };
      }),
      leaseTtlMs: 5_000,
    },
    claimed!,
  );
  assert.deepEqual(seen?.origin, { kind: "human", messageTs: "1" });
});

test("processRun heartbeats the lease while the turn runs, and the beat stops with the turn", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = createMemoryRunStore();
  const { runs, beats } = spyHeartbeats(store.runs);

  let release = (_: TurnResult) => {};
  const gate = new Promise<TurnResult>((resolve) => {
    release = resolve;
  });
  const orchestrator = fakeOrchestrator(() => gate);

  await runs.enqueue({ sessionId: "s1", request: turn });
  const run = await runs.claim("w1", 9_000);
  const pending = processRun({ runs, orchestrator, leaseTtlMs: 9_000 }, run!);

  t.mock.timers.tick(3_000);
  await microtasks();
  assert.equal(beats.length, 1, "one heartbeat per interval");
  assert.deepEqual(beats[0], { runId: run!.id, token: run!.leaseToken!, ttl: 9_000, ok: true });

  t.mock.timers.tick(6_000);
  await microtasks();
  assert.equal(beats.length, 3, "the beat keeps firing for as long as the turn runs");
  assert.ok(
    beats.every((b) => b.ok),
    "every renewal lands on the still-held lease",
  );

  release({ status: "ok", reply: "done" });
  await pending;
  t.mock.timers.tick(30_000);
  await microtasks();
  assert.equal(
    beats.length,
    3,
    "no heartbeat leaks past completion (a leak would keep renewing a finished run's lease)",
  );
});

test("a retryable turn failure requeues the run, rethrows, and stops the heartbeat", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = createMemoryRunStore();
  const { runs, beats } = spyHeartbeats(store.runs);

  let explode = (_: Error) => {};
  const gate = new Promise<TurnResult>((_, reject) => {
    explode = reject;
  });
  const orchestrator = fakeOrchestrator(() => gate);

  await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 });
  const run = await runs.claim("w1", 9_000);
  const pending = processRun({ runs, orchestrator, leaseTtlMs: 9_000 }, run!);

  t.mock.timers.tick(3_000);
  await microtasks();
  assert.equal(beats.length, 1);

  explode(new Error("provider hiccup"));
  await assert.rejects(pending, /provider hiccup/);

  const requeued = await runs.get(run!.id);
  assert.equal(requeued?.status, "pending", "an ordinary failure goes back on the queue");
  assert.equal(requeued?.attempts, 1);

  t.mock.timers.tick(30_000);
  await microtasks();
  assert.equal(beats.length, 1, "no heartbeat leaks past the failure");

  const retried = await runs.claim("w2", 9_000);
  assert.equal(retried?.id, run!.id, "another worker can pick the requeued run up");

  const seen: OrchestratorInput[] = [];
  await processRun(
    {
      runs,
      orchestrator: fakeOrchestrator(async (input) => {
        seen.push(input);
        return { status: "ok", reply: "resumed" };
      }),
      leaseTtlMs: 9_000,
    },
    retried!,
  );
  assert.equal(
    seen[0]?.attempt,
    2,
    "the retry carries its attempt number so the orchestrator can resume the interrupted turn",
  );
});

test("finalAttempt marks the attempt whose error would park the run, from the claim-time budget", async () => {
  const { runs } = createMemoryRunStore();
  const seen: OrchestratorInput[] = [];
  const orchestrator = fakeOrchestrator(async (input) => {
    seen.push(input);
    throw new Error("provider hiccup");
  });
  const deps = { runs, orchestrator, leaseTtlMs: 5_000 };

  await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 2 });
  const first = await runs.claim("w1", 5_000);
  await assert.rejects(processRun(deps, first!), /hiccup/);
  assert.equal(seen[0]?.finalAttempt, false, "budget remains — the orchestrator must not record a terminal failure");
  assert.equal((await runs.get(first!.id))?.status, "pending");

  const second = await runs.claim("w1", 5_000);
  await assert.rejects(processRun(deps, second!), /hiccup/);
  assert.equal(seen[1]?.finalAttempt, true, "the last budgeted attempt is marked — an error now is terminal");
  assert.equal((await runs.get(first!.id))?.status, "failed", "and the store indeed parks on its error");
});

test("finalAttempt also marks the claim-cap park — an error on an over-claimed run is terminal", async () => {
  const { runs } = createMemoryRunStore({ maxClaims: 3 });
  const seen: OrchestratorInput[] = [];
  const orchestrator = fakeOrchestrator(async (input) => {
    seen.push(input);
    throw new Error("provider hiccup");
  });

  await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 5 });
  for (let i = 0; i < 2; i++) {
    const r = await runs.claim("w1", 5_000);
    await runs.releaseLease(r!.id, r!.leaseToken!);
  }
  const third = await runs.claim("w1", 5_000);
  await assert.rejects(processRun({ runs, orchestrator, leaseTtlMs: 5_000 }, third!), /hiccup/);
  assert.equal(seen[0]?.finalAttempt, true, "claim cap reached — an error is terminal despite error budget left");
  assert.equal((await runs.get(third!.id))?.status, "failed");
});

function scriptedHeartbeat(runs: RunStore, script: Array<boolean | Error>): RunStore {
  return {
    ...runs,
    async heartbeat(runId, token, ttl) {
      if (script.length) {
        const next = script.shift()!;
        if (next instanceof Error) throw next;
        return next;
      }
      return runs.heartbeat(runId, token, ttl);
    },
  };
}

function cancellableOrchestrator(): { orchestrator: Orchestrator; cancelled: () => boolean; finish: () => void } {
  let wasCancelled = false;
  let resolveTurn: (r: TurnResult) => void = () => {};
  return {
    cancelled: () => wasCancelled,
    finish: () => resolveTurn({ status: "ok", reply: "finished" }),
    orchestrator: fakeOrchestrator(
      (input) =>
        new Promise<TurnResult>((resolve) => {
          resolveTurn = resolve;
          input.cancel?.addEventListener("abort", () => {
            wasCancelled = true;
            resolve({ status: "ok", reply: "cancelled" });
          });
        }),
    ),
  };
}

test("a thrown heartbeat (a DB blip) never cancels the turn", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = createMemoryRunStore();
  const runs = scriptedHeartbeat(
    store.runs,
    Array.from({ length: 10 }, () => new Error("pg down")),
  );
  const { orchestrator, cancelled, finish } = cancellableOrchestrator();

  await store.runs.enqueue({ sessionId: "s1", request: turn });
  const run = await store.runs.claim("w1", 9_000);
  const pending = processRun({ runs, orchestrator, leaseTtlMs: 9_000 }, run!);

  for (let i = 0; i < LEASE_LOST_CONSECUTIVE + 3; i++) {
    t.mock.timers.tick(3_000);
    await microtasks();
  }
  assert.equal(cancelled(), false, "thrown beats are transient and never abort the turn");
  finish();
  await pending;
});

test("a single definitive lease-lost beat does not cancel, but N consecutive do", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = createMemoryRunStore();
  const script: Array<boolean | Error> = [false, true, ...Array.from({ length: LEASE_LOST_CONSECUTIVE }, () => false)];
  const runs = scriptedHeartbeat(store.runs, script);
  const { orchestrator, cancelled } = cancellableOrchestrator();

  await store.runs.enqueue({ sessionId: "s1", request: turn });
  const run = await store.runs.claim("w1", 9_000);
  const pending = processRun({ runs, orchestrator, leaseTtlMs: 9_000 }, run!);

  t.mock.timers.tick(3_000);
  await microtasks();
  assert.equal(cancelled(), false, "one false is not conclusive");
  t.mock.timers.tick(3_000);
  await microtasks();
  assert.equal(cancelled(), false, "a held beat clears the lost streak");

  for (let i = 0; i < LEASE_LOST_CONSECUTIVE - 1; i++) {
    t.mock.timers.tick(3_000);
    await microtasks();
    assert.equal(cancelled(), false, "still short of the consecutive threshold");
  }
  t.mock.timers.tick(3_000);
  await microtasks();
  assert.equal(cancelled(), true, "N consecutive definitive lease-lost beats cancel the turn");
  await pending;
});

test("the heartbeat stops before complete(), so a late tick cannot spuriously abort", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = createMemoryRunStore();
  const { runs, beats } = spyHeartbeats(store.runs);

  let release = (_: TurnResult) => {};
  const gate = new Promise<TurnResult>((resolve) => {
    release = resolve;
  });
  const orchestrator = fakeOrchestrator(() => gate);

  await runs.enqueue({ sessionId: "s1", request: turn });
  const run = await runs.claim("w1", 9_000);
  const pending = processRun({ runs, orchestrator, leaseTtlMs: 9_000 }, run!);

  t.mock.timers.tick(3_000);
  await microtasks();
  assert.equal(beats.length, 1);

  release({ status: "ok", reply: "done" });
  await pending;

  const beatsAtComplete = beats.length;
  t.mock.timers.tick(30_000);
  await microtasks();
  assert.equal(
    beats.length,
    beatsAtComplete,
    "no beat fires after the terminal write — the interval was stopped first",
  );
  assert.equal((await runs.get(run!.id))?.status, "done", "the run completed normally, not aborted");
});

test("a NonRetryableTurnError parks the run even with attempts remaining", async () => {
  const { runs } = createMemoryRunStore();
  const orchestrator = fakeOrchestrator(async () => {
    throw new NonRetryableTurnError("policy says no");
  });

  await runs.enqueue({ sessionId: "s1", request: turn, maxAttempts: 3 });
  const run = await runs.claim("w1", 5_000);
  await assert.rejects(processRun({ runs, orchestrator, leaseTtlMs: 5_000 }, run!), /policy says no/);

  const parked = await runs.get(run!.id);
  assert.equal(parked?.status, "failed", "no retry for an error the turn itself declared permanent");
  assert.equal(parked?.attempts, 1, "parked on the first attempt, not after exhausting maxAttempts");
  assert.equal(parked?.result?.reason, "policy says no");
});
