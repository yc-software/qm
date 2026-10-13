import { test } from "node:test";
import assert from "node:assert/strict";
import { retryDelay } from "../src/runs/retry-delay.ts";
import { processRun } from "../src/runs/worker.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { NonRetryableTurnError, ProviderTurnError } from "../src/core/turn-error.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";

const request: OrchestratorInput = {
  actor: { id: "retry-test", type: "internal" },
  conversation: { kind: "dm", threadRef: "retry-test", audience: [] },
  origin: { kind: "direct" },
  text: "test",
};

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

test("workers delay all failed-turn retries and respect terminal budgets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { runs } = createMemoryRunStore();
  const run = (await runs.enqueue({ sessionId: "retry-test", request })).run;
  const error = new Error("dependency unavailable");
  const orchestrator = {
    handleTurn: async () => {
      throw error;
    },
  } as unknown as Orchestrator;
  for (let i = 0; i < 3; i++) {
    const claimed = await runs.claim("worker", 60_000);
    assert.ok(claimed);
    await assert.rejects(processRun({ runs, orchestrator, leaseTtlMs: 60_000 }, claimed), error);
    if (i < 2) {
      assert.equal((await runs.get(run.id))?.status, "pending");
      assert.equal(await runs.claim("other-worker", 60_000), null);
      t.mock.timers.tick(60_000);
    }
  }
  assert.equal((await runs.get(run.id))?.status, "failed");
  assert.equal((await runs.get(run.id))?.errorAttempts, 3);
  for (const error of [new Error("ordinary"), new NonRetryableTurnError("permanent")]) {
    const { run } = await runs.enqueue({ sessionId: "other", request });
    const lease = await runs.claim("worker", 60_000);
    assert.ok(lease);
    const orchestrator = {
      handleTurn: async () => {
        throw error;
      },
    } as unknown as Orchestrator;
    await assert.rejects(processRun({ runs, orchestrator, leaseTtlMs: 60_000 }, lease), error);
    if (error instanceof NonRetryableTurnError) assert.equal((await runs.get(run.id))?.status, "failed");
    else {
      assert.equal(await runs.claimById(run.id, "other", 60_000), null);
      t.mock.timers.tick(60_000);
      assert.ok(await runs.claimById(run.id, "other", 60_000));
      await runs.fail(run.id, (await runs.get(run.id))!.leaseToken!, "done", { retry: false });
    }
  }
});

test("a provider-requested delay holds the retry until it passes, up to ten minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.method(Math, "random", () => 0);
  const { runs } = createMemoryRunStore();
  for (const [retryAfterMs, heldMs] of [
    [120_000, 120_000],
    [1_000, 15_000],
    [3_600_000, 600_000],
  ] as const) {
    const { run } = await runs.enqueue({ sessionId: `provider-${retryAfterMs}`, request });
    const lease = await runs.claimById(run.id, "worker", 60_000);
    assert.ok(lease);
    const error = new ProviderTurnError("slow down", { code: "rate_limit", retryable: true, retryAfterMs, raw: "" });
    const orchestrator = {
      handleTurn: async () => {
        throw error;
      },
    } as unknown as Orchestrator;
    await assert.rejects(processRun({ runs, orchestrator, leaseTtlMs: 60_000 }, lease), error);
    t.mock.timers.tick(heldMs - 1);
    assert.equal(await runs.claimById(run.id, "other", 60_000), null);
    t.mock.timers.tick(1);
    assert.ok(await runs.claimById(run.id, "other", 60_000));
    await runs.fail(run.id, (await runs.get(run.id))!.leaseToken!, "done", { retry: false });
  }
});
