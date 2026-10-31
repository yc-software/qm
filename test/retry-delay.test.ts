import { test } from "node:test";
import assert from "node:assert/strict";
import { NonRetryableTurnError, ProviderTurnError } from "../src/core/turn-error.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";
import { TURN_QUEUES } from "../src/turns/absurd-schema.ts";
import { createTurnRunner } from "../src/turns/turn-runner.ts";
import type { TurnResult } from "../src/types.ts";
import pg from "pg";
import { turnLedgerAt } from "./support/absurd-clock.ts";
import { eventually } from "./support/settle.ts";
import { claimTurn, testRunStore } from "./support/turns.ts";

const request: OrchestratorInput = {
  actor: { id: "retry-test", type: "internal" },
  conversation: { kind: "dm", threadRef: "retry-test", audience: [] },
  origin: { kind: "direct" },
  text: "test",
};

const LATER_THAN_ANY_BACKOFF_MS = 10 * 60_000;

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

test("a failed turn is retried only after its backoff, within QM's error budget, then records the failure", async () => {
  const { runs, ledger, databaseUrl, close } = testRunStore();
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const later = turnLedgerAt(databaseUrl, Date.now() + LATER_THAN_ANY_BACKOFF_MS);
  const { orchestrator, calls } = throwing(
    () => new ProviderTurnError("slow down", { code: "rate_limit", retryable: true, status: 429, raw: "429" }),
  );
  const first = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 1, pollMs: 20 });
  const second = createTurnRunner({ ledger: later, orchestrator, queues: TURN_QUEUES, slots: 1, pollMs: 20 });
  try {
    const admitted = await ledger.admit({ sessionId: "retry-test", request, priority: 0, maxAttempts: 2 });
    const run = admitted!.run;
    first.start();
    const pending = await eventually(() => runs.get(run.id), {
      until: (found) => found?.errorAttempts === 1,
      label: "first failure handed back",
    });
    assert.equal(pending?.status, "pending");
    assert.equal(await claimTurn(ledger), null, "the retry is not claimable before its backoff");
    await first.stopClaims();
    assert.equal(calls(), 1, "the turn is not retried before its backoff");

    second.start();
    const failed = await eventually(() => runs.get(run.id), {
      until: (found) => found?.status === "failed",
      label: "budget exhausted",
    });
    assert.equal(calls(), 2, "the retry runs once its backoff has passed");
    assert.equal(failed?.errorAttempts, 2);
    assert.equal(failed?.attempts, 2);
    assert.equal(failed?.result?.status, "failed");
    assert.equal(failed?.result?.sessionId, "retry-test");
    assert.equal(failed?.result?.errorCode, "rate_limit", "the provider error code survives to the result");
    assert.match(failed?.result?.reason ?? "", /slow down|rate/i, "the failure keeps its reason");
    const { rows } = await admin.query("SELECT active_turn_id FROM session_turn_pointers WHERE thread_ref = $1", [
      "retry-test",
    ]);
    assert.equal(rows[0]?.active_turn_id ?? null, null, "the conversation is free for its next turn");
  } finally {
    await first.stopClaims();
    await second.stopClaims();
    await later.close();
    await admin.end();
    await close();
  }
});

test("a non-retryable failure fails the turn at once", async () => {
  const { runs, ledger, close } = testRunStore();
  const { orchestrator, calls } = throwing(() => new NonRetryableTurnError("permanent"));
  const runner = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 1, pollMs: 20 });
  try {
    const { run } = await runs.enqueue({ sessionId: "retry-test", request, maxAttempts: 3 });
    runner.start();
    const ended = await eventually(() => runs.get(run.id), {
      until: (found) => found?.status === "failed" || found?.errorAttempts === 1,
      label: "permanent failure",
    });
    assert.equal(ended?.status, "failed");
    assert.equal(ended?.attempts, 1);
    assert.equal(calls(), 1);
    assert.match(ended?.result?.reason ?? "", /permanent/);
  } finally {
    await runner.stopClaims();
    await close();
  }
});
