import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetAdjustmentForRequest,
  createBudgetTracker,
  estimateCostUsd,
  modelCallCostUsd,
} from "../src/ratelimit/budget.ts";
import { DEFAULT_AGENT_INPUT_USD_PER_MTOK } from "../src/model/pi-models.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("budget tracker accumulates per-principal and trips at the limit", async () => {
  const b = createBudgetTracker({ limitUsd: 1, windowMs: 60_000 });
  assert.equal((await b.check("U1")).allowed, true);
  await b.record("U1", 0.6, 1000);
  assert.equal((await b.check("U1", 1000)).allowed, true);
  await b.record("U1", 0.6, 1000);
  assert.equal((await b.check("U1", 1000)).allowed, false);
  assert.equal((await b.check("U2", 1000)).allowed, true);
  assert.equal((await b.check("U1", 1000 + 61_000)).allowed, true);
});

test("caps are opt-in: an unconfigured tracker never refuses, a configured one does", async () => {
  const unbounded = createBudgetTracker();
  await unbounded.record("U1", 1_000_000);
  assert.equal((await unbounded.check("U1")).allowed, true, "no configured cap = unlimited (upgrade safety)");
  const capped = createBudgetTracker({ limitUsd: 25 });
  await capped.record("U1", 26);
  assert.equal((await capped.check("U1")).allowed, false);
  assert.equal(estimateCostUsd(1000) > 0, true);
  assert.equal(estimateCostUsd(1_000_000), DEFAULT_AGENT_INPUT_USD_PER_MTOK);
});

test("the org cap holds across principals", async () => {
  const b = createBudgetTracker({ limitUsd: 100, orgLimitUsd: 1, windowMs: 60_000 });
  await b.record("U1", 0.6, 1000);
  await b.record("U2", 0.6, 1000);
  assert.equal((await b.check("U3", 1000)).allowed, false);
});

test("a principal over budget is refused by the app", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-bud-")),
    budgetUsdPerWindow: 0.00001,
  });
  const { app } = buildApp(config);
  const dm = (text: string): TurnRequest => ({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text,
  });

  const first = await app.turn(dm("hello"));
  assert.equal(first.status, "ok");
  const second = await app.turn(dm("again"));
  assert.equal(second.status, "refused");
  assert.match(second.reason ?? "", /budget exceeded/);
});

test("modelCallCostUsd prefers provider-metered cost, then metered tokens, then the estimate (#586)", () => {
  const rec = { model: "gpt-5.6-sol", inputTokens: 1000 };

  // Provider computed the cost: used verbatim.
  assert.equal(
    modelCallCostUsd(rec, { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 3000, costUsd: 0.07 }),
    0.07,
  );

  // Metered tokens but no provider cost: input+output at the fixed rate
  // (output no longer invisible).
  assert.equal(
    modelCallCostUsd(rec, { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 3000, costUsd: 0 }),
    estimateCostUsd(3000),
  );

  // No metered usage at all: the legacy input-only estimate.
  assert.equal(modelCallCostUsd(rec, null), estimateCostUsd(1000));
  assert.equal(modelCallCostUsd(rec, undefined), estimateCostUsd(1000));
});

test("budgetAdjustmentForRequest credits a cache-folded booking back to metered (#586 follow-up)", () => {
  // The claude harness books estimateCostUsd(input + cacheRead + cacheWrite)
  // upfront at the FULL fixed rate; the provider-metered costUsd prices cache
  // correctly and is lower. The adjustment must be NEGATIVE so the running
  // total lands on the metered figure — the cache-read false trip.
  const usage = { input: 1_000, output: 500, cacheRead: 500_000, cacheWrite: 100_000, totalTokens: 601_500, costUsd: 0.42 };
  const adjustment = budgetAdjustmentForRequest(usage);
  // The booking formula is input+cacheRead+cacheWrite (claude-harness.ts:613) — no output.
  const booked = estimateCostUsd(601_000);
  assert.ok(adjustment < 0, `expected a credit, got ${adjustment}`);
  assert.ok(Math.abs(adjustment - (0.42 - booked)) < 1e-9, "exactly metered minus booked");
  // A budget tracker's running total lands on the metered figure after the
  // upfront + correction.
  const tracker = createBudgetTracker({});
  void tracker.record("u1", booked);
  void tracker.record("u1", adjustment);
  return tracker.check("u1").then((c) => {
    assert.ok(Math.abs(c.spentUsd - 0.42) < 1e-9, `total should be the metered cost, got ${c.spentUsd}`);
  });
});

test("budgetAdjustmentForRequest only tops up estimate-fed (cache-less) usage", () => {
  // pi-shape: no cache fields, upfront not reconstructible — positive-only.
  const usage = { input: 1_000, output: 2_000, cacheRead: 0, cacheWrite: 0, totalTokens: 3_000, costUsd: 0.07 };
  assert.ok(budgetAdjustmentForRequest(usage) >= 0);
  assert.equal(budgetAdjustmentForRequest(null), 0);
  assert.equal(budgetAdjustmentForRequest(undefined), 0);
});
