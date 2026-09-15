import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLoadShedGate,
  nextShedState,
  RESUME_BELOW_UTILIZATION,
  SHED_AT_UTILIZATION,
} from "../src/runs/load-shed.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const burn = (ms: number): void => {
  const end = Date.now() + ms;
  while (Date.now() < end) Math.sqrt(Math.random());
};

test("shedding starts at the high threshold and only clears below the low one", () => {
  assert.equal(nextShedState(false, SHED_AT_UTILIZATION - 0.01), false);
  assert.equal(nextShedState(false, SHED_AT_UTILIZATION), true);
  assert.equal(
    nextShedState(true, RESUME_BELOW_UTILIZATION),
    true,
    "between the thresholds a shedding gate stays shut",
  );
  assert.equal(nextShedState(true, RESUME_BELOW_UTILIZATION - 0.01), false);
});

test("the gate stops claims while the loop is saturated and reopens once it idles", async () => {
  let utilization = 0;
  const gate = createLoadShedGate({ sampler: { start() {}, stop() {}, utilization: () => utilization }, sampleMs: 5 });
  gate.start();
  try {
    assert.equal(gate.canClaim(), true);
    utilization = 0.95;
    await sleep(30);
    assert.equal(gate.canClaim(), false);
    utilization = 0.7;
    await sleep(30);
    assert.equal(gate.canClaim(), false, "hysteresis: 70% is below shed but above resume");
    utilization = 0.1;
    await sleep(30);
    assert.equal(gate.canClaim(), true);
  } finally {
    gate.stop();
  }
});

test("a real synchronous stall on this process's event loop trips the default sampler", async () => {
  const gate = createLoadShedGate({ sampleMs: 100 });
  gate.start();
  try {
    await sleep(150);
    assert.equal(gate.canClaim(), true, "an idle loop keeps the gate open");
    burn(400);
    await sleep(0);
    assert.equal(gate.canClaim(), false, "the sample taken right after a fully busy window pauses claims");
    await sleep(400);
    assert.equal(gate.canClaim(), true, "an idle window afterwards resumes claims");
  } finally {
    gate.stop();
  }
});
