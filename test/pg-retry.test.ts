import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresRetryDelay } from "../src/persistence/pg-retry.ts";
import { processRun } from "../src/runs/worker.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import type { Orchestrator, OrchestratorInput } from "../src/core/orchestrator.ts";

const request: OrchestratorInput = {
  actor: { id: "retry-test", type: "internal" },
  conversation: { kind: "dm", threadRef: "retry-test", audience: [] },
  origin: { kind: "direct" },
  text: "test",
};

test("Postgres outage delays grow with jitter and stay capped", () => {
  for (const code of ["53300", "57P01", "57P02", "57P03", "08006"]) {
    const error = Object.assign(new Error("unavailable"), { code });
    for (const [attempt, min, max] of [
      [0, 15000, 18000],
      [1, 30000, 36000],
      [2, 60000, 60000],
      [100, 60000, 60000],
    ]) {
      const delay = postgresRetryDelay(new Error("wrapped", { cause: error }), attempt!)!;
      assert.ok(delay >= min! && delay <= max!);
    }
  }
  assert.ok(postgresRetryDelay(new Error("Connection terminated unexpectedly"), 0));
  assert.ok(postgresRetryDelay(new Error("timeout exceeded when trying to connect"), 0));
  for (const error of [new Error("application failure"), { code: "23505" }, { code: "42601" }, null]) {
    assert.equal(postgresRetryDelay(error, 0), undefined);
  }
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(postgresRetryDelay(cycle, 0), undefined);
});

test("workers schedule Postgres retries, keep other errors immediate, and respect terminal budgets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { runs } = createMemoryRunStore();
  const run = (await runs.enqueue({ sessionId: "retry-test", request })).run;
  const error = Object.assign(new Error("too many connections"), { code: "53300" });
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
      assert.ok(await runs.claimById(run.id, "other", 60_000));
      await runs.fail(run.id, (await runs.get(run.id))!.leaseToken!, "done", { retry: false });
    }
  }
});
