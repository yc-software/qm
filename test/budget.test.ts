import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBudgetTracker,
  createModelUsageMeter,
  estimateCostUsd,
  priceModelUsage,
} from "../src/ratelimit/budget.ts";
import { DEFAULT_AGENT_INPUT_USD_PER_MTOK } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
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

test("pricing includes output and cache rates and rejects invalid or unknown inputs", () => {
  const priced = priceModelUsage("claude-haiku-4-5", {
    input: 1_000_000,
    output: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
  });
  assert.equal(priced.priced, true);
  assert.equal(priced.priced && priced.costUsd > estimateCostUsd(1_000_000), true);
  assert.deepEqual(priceModelUsage("missing-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), {
    priced: false,
    reason: "pricing is unavailable for model missing-model",
  });
  assert.equal(
    priceModelUsage("claude-haiku-4-5", { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 }).priced,
    false,
  );
  assert.deepEqual(priceModelUsage("missing-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0), {
    priced: true,
    costUsd: 0,
    basis: "reported_api_equivalent",
  });
});

test("reservations settle both upward and downward exactly once", async () => {
  const b = createBudgetTracker({ limitUsd: 10, windowMs: 60_000 });
  await b.reserve({ operationId: "down", principalId: "U1", model: "m", reservedUsd: 4, now: 1000 });
  await b.settle({ operationId: "down", principalId: "U1", model: "m", settledUsd: 1, now: 1100 });
  assert.equal((await b.check("U1", 1100)).spentUsd, 1);
  await b.settle({ operationId: "down", principalId: "U1", model: "m", settledUsd: 1, now: 1200 });
  await b.reserve({ operationId: "up", principalId: "U1", model: "m", reservedUsd: 1, now: 1200 });
  await b.settle({ operationId: "up", principalId: "U1", model: "m", settledUsd: 5, now: 1300 });
  assert.equal((await b.check("U1", 1300)).spentUsd, 6);
  await assert.rejects(
    b.settle({ operationId: "up", principalId: "U1", model: "m", settledUsd: 6 }),
    /settlement conflict/,
  );
});

test("progressive checkpoints charge known usage without becoming terminal settlement", async () => {
  const b = createBudgetTracker({ limitUsd: 10, windowMs: 60_000 });
  await b.reserve({ operationId: "progress", principalId: "U1", model: "m", reservedUsd: 2, now: 1000 });
  await b.checkpoint({ operationId: "progress", principalId: "U1", model: "m", knownUsd: 5, now: 1100 });
  assert.equal((await b.check("U1", 1100)).spentUsd, 5);
  await b.checkpoint({ operationId: "progress", principalId: "U1", model: "m", knownUsd: 3, now: 1200 });
  assert.equal((await b.check("U1", 1200)).spentUsd, 5);
  await b.settle({ operationId: "progress", principalId: "U1", model: "m", settledUsd: 1, now: 1300 });
  assert.equal((await b.check("U1", 1300)).spentUsd, 1);
  await b.checkpoint({ operationId: "progress", principalId: "U1", model: "m", knownUsd: 9, now: 1400 });
  assert.equal((await b.check("U1", 1400)).spentUsd, 1);
});

test("a replay keeps its durable quote through removal, invalidation, and repricing", async () => {
  const provider = (rates: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => ({
    id: "priced-test",
    name: "Priced Test",
    protocol: "anthropic" as const,
    baseUrl: "https://priced.test/v1",
    models: [{ id: "priced-test/model", ...rates }],
  });
  const usage = { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  try {
    setCustomProviders([provider({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })]);
    const b = createBudgetTracker({ limitUsd: 100 });
    for (const attempt of ["removed", "invalidated", "repriced", "identity"]) {
      await createModelUsageMeter(b, "U1", attempt)!.reserve("priced-test/model", 1_000_000);
    }

    setCustomProviders([]);
    const removed = createModelUsageMeter(b, "U1", "removed")!;
    const removedId = await removed.reserve("priced-test/model", 1_000_000);
    await removed.settle(removedId, "priced-test/model", usage);
    await assert.rejects(
      createModelUsageMeter(b, "U1", "new-after-removal")!.reserve("priced-test/model", 1_000_000),
      /unpriced model request/,
    );

    setCustomProviders([provider({ input: 1, output: 1 })]);
    const invalidated = createModelUsageMeter(b, "U1", "invalidated")!;
    const invalidatedId = await invalidated.reserve("priced-test/model", 1_000_000);
    await invalidated.settle(invalidatedId, "priced-test/model", usage);
    await assert.rejects(
      createModelUsageMeter(b, "U1", "new-after-invalidation")!.reserve("priced-test/model", 1_000_000),
      /unpriced model request/,
    );
    await assert.rejects(
      createModelUsageMeter(b, "U2", "identity")!.reserve("priced-test/model", 1_000_000),
      /identity conflict/,
    );
    await assert.rejects(
      createModelUsageMeter(b, "U1", "identity")!.reserve("priced-test/other", 1_000_000),
      /identity conflict/,
    );

    setCustomProviders([provider({ input: 9, output: 9, cacheRead: 9, cacheWrite: 9 })]);
    const repriced = createModelUsageMeter(b, "U1", "repriced")!;
    const repricedId = await repriced.reserve("priced-test/model", 1_000_000);
    await repriced.settle(repricedId, "priced-test/model", usage);
    assert.equal((await b.check("U1")).spentUsd, 7);
  } finally {
    setCustomProviders([]);
  }
});

test("custom pricing distinguishes omitted fields from explicit zero rates", () => {
  const base = {
    id: "raw-price-test",
    name: "Raw Price Test",
    protocol: "openai" as const,
    baseUrl: "https://raw-price.test/v1",
  };
  try {
    setCustomProviders([{ ...base, models: [{ id: "raw-price-test/missing", input: 0, output: 0 }] }]);
    assert.equal(
      priceModelUsage("raw-price-test/missing", { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }).priced,
      false,
    );
    setCustomProviders([
      {
        ...base,
        models: [{ id: "raw-price-test/zero", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
      },
    ]);
    assert.deepEqual(priceModelUsage("raw-price-test/zero", { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }), {
      priced: true,
      costUsd: 0,
      basis: "api_equivalent",
    });
  } finally {
    setCustomProviders([]);
  }
});

test("reservation identity is idempotent while crash residue expires at its original window", async () => {
  const b = createBudgetTracker({ limitUsd: 1, windowMs: 1000 });
  const request = { operationId: "attempt-1:0", principalId: "U1", model: "m", reservedUsd: 1 };
  assert.equal((await b.reserve({ ...request, now: 1000 })).allowed, true);
  assert.equal((await b.reserve({ ...request, now: 1000 })).allowed, true);
  assert.equal((await b.check("U1", 1000)).spentUsd, 1);
  assert.equal((await b.check("U1", 1000)).allowed, false);
  assert.equal((await b.check("U1", 2001)).allowed, true);
  await assert.rejects(b.reserve({ ...request, model: "other", now: 1000 }), /identity conflict/);
});

test("scoped meter refuses unknown pricing before recording a free guess", async () => {
  const b = createBudgetTracker({ limitUsd: 1 });
  const meter = createModelUsageMeter(b, "U1", "attempt")!;
  await assert.rejects(meter.reserve("missing-model", 100), /unpriced model request/);
  assert.equal((await b.check("U1")).spentUsd, 0);
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
