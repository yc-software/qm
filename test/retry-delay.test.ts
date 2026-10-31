import { test } from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "../src/runs/retry-delay.ts";
import { NonRetryableTurnError, ProviderTurnError } from "../src/core/turn-error.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { TURN_QUEUES } from "../src/turns/absurd-schema.ts";
import { createTurnRunner } from "../src/turns/turn-runner.ts";
import type { TurnResult } from "../src/types.ts";
import { sleep } from "../src/util/async.ts";
import pg from "pg";
import { eventually } from "./support/settle.ts";
import { claimTurn, testRunStore } from "./support/turns.ts";

const request: OrchestratorInput = {
  actor: { id: "retry-test", type: "internal" },
  conversation: { kind: "dm", threadRef: "retry-test", audience: [] },
  origin: { kind: "direct" },
  text: "test",
};

function throwing(errors: () => unknown): { orchestrator: Orchestrator; calls: () => number } {
  let calls = 0;
  return {
    orchestrator: {
      handleTurn: async (): Promise<TurnResult> => {
        calls += 1;
        throw errors();
      },
    } as unknown as Orchestrator,
    calls: () => calls,
  };
}

test("retry delays grow with bounded jitter and stay capped", (t) => {
  for (const random of [0, 0.5, 0.999999]) {
    t.mock.method(Math, "random", () => random);
    for (const [attempt, base] of [
      [0, 15000],
      [1, 30000],
      [2, 60000],
      [100, 60000],
    ]) {
      assert.equal(retryDelay(attempt!), Math.min(60000, Math.round(base! * (1 + random * 0.2))));
    }
    t.mock.restoreAll();
  }
});

test("the runner schedules a failed turn's retry after the default backoff", async () => {
  const { runs, ledger, databaseUrl, close } = testRunStore();
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const { orchestrator, calls } = throwing(() => new Error("dependency unavailable"));
  const runner = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 1, pollMs: 20 });
  try {
    const run = (await runs.enqueue({ sessionId: "retry-test", request })).run;
    const failedAt = Date.now();
    runner.start();
    const pending = await eventually(() => runs.get(run.id), {
      until: (found) => found?.errorAttempts === 1,
      label: "first failure handed back",
    });
    assert.equal(pending?.status, "pending");
    const { rows } = await admin.query(`SELECT available_at FROM absurd.r_${run.absurdQueue} WHERE run_id = $1`, [
      pending!.absurdRunId,
    ]);
    const wakeIn = new Date(rows[0]!.available_at as string).getTime() - failedAt;
    assert.ok(wakeIn >= 15_000 - 1_000, `retry waits the 15s base backoff (got ${wakeIn}ms)`);
    assert.ok(wakeIn <= 18_000 + 1_000, `retry waits at most the jittered backoff (got ${wakeIn}ms)`);
    await sleep(300);
    assert.equal(calls(), 1, "the turn is not retried before its delay");
    assert.equal(await claimTurn(ledger), null, "no other worker can claim it early either");
  } finally {
    await runner.stopClaims();
    await admin.end();
    await close();
  }
});

test("the runner delays every failed-turn retry and respects terminal budgets", async () => {
  const { runs, ledger, close } = testRunStore();
  const delays: number[] = [];
  const { orchestrator, calls } = throwing(
    () => new ProviderTurnError("slow down", { code: "rate_limit", retryable: true, status: 429, raw: "429" }),
  );
  const runner = createTurnRunner({
    ledger,
    orchestrator,
    queues: TURN_QUEUES,
    slots: 1,
    pollMs: 20,
    retryDelayMs: (priorErrors) => {
      delays.push(priorErrors);
      return 1_500;
    },
  });
  try {
    const run = (await runs.enqueue({ sessionId: "retry-test", request, maxAttempts: 3 })).run;
    runner.start();
    await eventually(() => runs.get(run.id), { until: (found) => found?.errorAttempts === 1, label: "first retry" });
    await sleep(300);
    assert.equal(calls(), 1, "the retry waits for its delay");
    const failed = await eventually(() => runs.get(run.id), {
      until: (found) => found?.status === "failed",
      label: "budget exhausted",
    });
    assert.equal(calls(), 3);
    assert.deepEqual(delays, [0, 1], "each retry is delayed by the error count so far; the last attempt is not");
    assert.equal(failed?.errorAttempts, 3);
    assert.equal(failed?.attempts, 3);
    assert.equal(failed?.result?.status, "failed");
    assert.equal(failed?.result?.sessionId, "retry-test");
    assert.equal(failed?.result?.errorCode, "rate_limit", "the provider error code survives to the result");
    assert.match(failed?.result?.reason ?? "", /slow down|rate/i, "the failure keeps its reason");
  } finally {
    await runner.stopClaims();
    await close();
  }
});

test("a non-retryable failure fails the turn at once; an ordinary one is retried later", async () => {
  const { runs, ledger, close } = testRunStore();
  try {
    for (const error of [new NonRetryableTurnError("permanent"), new Error("ordinary")]) {
      const { orchestrator, calls } = throwing(() => error);
      const runner = createTurnRunner({
        ledger,
        orchestrator,
        queues: TURN_QUEUES,
        slots: 1,
        pollMs: 20,
        retryDelayMs: () => 60_000,
      });
      const { run } = await runs.enqueue({ sessionId: `other-${error.message}`, request, maxAttempts: 3 });
      runner.start();
      try {
        const ended = await eventually(() => runs.get(run.id), {
          until: (found) => found?.status === "failed" || found?.errorAttempts === 1,
          label: error.message,
        });
        if (error instanceof NonRetryableTurnError) {
          assert.equal(ended?.status, "failed");
          assert.equal(ended?.attempts, 1);
          assert.match(ended?.result?.reason ?? "", /permanent/);
        } else {
          assert.equal(ended?.status, "pending", "an ordinary error is retried");
          await sleep(200);
          assert.equal(calls(), 1);
          assert.equal(await claimTurn(ledger, run.id), null, "not before the retry delay");
        }
      } finally {
        await runner.stopClaims();
      }
    }
  } finally {
    await close();
  }
});
