import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PROVIDER_RETRY_AFTER_MS, retryDelay, runRetryDelay } from "../src/runs/retry-delay.ts";
import { processRun } from "../src/runs/worker.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { NonRetryableTurnError, ProviderTurnError, retryAfterHintMs } from "../src/core/turn-error.ts";
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

test("provider retry hints are parsed from error text", () => {
  const cases: Array<[string, number | undefined]> = [
    ["Server requested 120s retry delay (max: 60s). 429 rate limit", 120_000],
    ["Rate limit reached for gpt-5 on RPM. Please try again in 120ms.", 120],
    ["Rate limit reached. Please try again in 1.5s.", 1_500],
    ["litellm.RateLimitError: retry after 20 seconds", 20_000],
    ["quota resets; try again in 2 minutes", 120_000],
    ["500 Internal server error", undefined],
  ];
  for (const [message, want] of cases) assert.equal(retryAfterHintMs(message), want, message);
});

test("run retry waits at least as long as the provider asked, bounded", () => {
  for (let i = 0; i < 50; i++) {
    const plain = runRetryDelay(0, new Error("x"));
    assert.ok(plain >= 15_000 && plain <= 18_000, String(plain));
    assert.equal(runRetryDelay(0, new ProviderTurnError("x", 180_000)), 180_000);
    assert.equal(runRetryDelay(0, new ProviderTurnError("x", 24 * 3_600_000)), MAX_PROVIDER_RETRY_AFTER_MS);
    assert.ok(runRetryDelay(0, new ProviderTurnError("x", 100)) >= 15_000, "short hints keep the backoff floor");
  }
});
