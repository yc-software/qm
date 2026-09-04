import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresBudgetTracker } from "../src/ratelimit/postgres-budget.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres budget tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS budget_spend CASCADE");
  await p.end();
});

test(
  "pg budget: spend is shared across trackers (instances), trips at the limit, and expires out of the window",
  { skip },
  async () => {
    const a = createPostgresBudgetTracker(URL!, { limitUsd: 1, windowMs: 60_000 });
    const b = createPostgresBudgetTracker(URL!, { limitUsd: 1, windowMs: 60_000 });

    assert.equal((await a.check("U1", 1000)).allowed, true);
    await a.record("U1", 0.6, 1000);
    assert.equal((await b.check("U1", 1000)).allowed, true, "under the cap is visible from another instance");
    await b.record("U1", 0.6, 1000);

    const tripped = await a.check("U1", 1000);
    assert.equal(tripped.allowed, false, "the cap holds fleet-wide, not per instance");
    assert.equal(tripped.spentUsd > 1, true);

    assert.equal((await a.check("U2", 1000)).allowed, true, "budgets are per-principal");
    assert.equal((await a.check("U1", 1000 + 61_000)).allowed, true, "spend outside the window no longer counts");
  },
);

test("pg budget: caps are opt-in — unconfigured allows, configured refuses", { skip }, async () => {
  const unbounded = createPostgresBudgetTracker(URL!);
  await unbounded.record("U1", 9_999, 1000);
  assert.equal((await unbounded.check("U1", 1000)).allowed, true, "no configured cap = unlimited (upgrade safety)");
  const capped = createPostgresBudgetTracker(URL!, { limitUsd: 25 });
  const c = await capped.check("U1", 1000);
  assert.equal(c.allowed, false);
  assert.equal(c.spentUsd, 9_999);
});
