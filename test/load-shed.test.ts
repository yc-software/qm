import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoadShedGate, nextShedState, RESUME_BELOW_LAG_MS, SHED_AT_LAG_MS } from "../src/runs/load-shed.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("shedding starts at the high threshold and only clears below the low one", () => {
  assert.equal(nextShedState(false, SHED_AT_LAG_MS - 1), false);
  assert.equal(nextShedState(false, SHED_AT_LAG_MS), true);
  assert.equal(nextShedState(true, RESUME_BELOW_LAG_MS), true, "between the thresholds a shedding gate stays shut");
  assert.equal(nextShedState(true, RESUME_BELOW_LAG_MS - 1), false);
});

test("the gate stops claims while the loop is lagging and reopens once it recovers", async () => {
  let lag = 0;
  const gate = createLoadShedGate({ sampleLagP99Ms: () => lag, sampleMs: 5 });
  gate.start();
  try {
    assert.equal(gate.canClaim(), true);
    lag = 1_000;
    await sleep(30);
    assert.equal(gate.canClaim(), false);
    lag = 150;
    await sleep(30);
    assert.equal(gate.canClaim(), false, "hysteresis: 150ms is below shed but above resume");
    lag = 20;
    await sleep(30);
    assert.equal(gate.canClaim(), true);
  } finally {
    gate.stop();
  }
});
