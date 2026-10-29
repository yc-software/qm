import test from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "./support/mock-harness.ts";

test("model utilities are independent from turn control", async () => {
  const harness = createMockHarness();

  assert.equal(typeof harness.turns.runTurn, "function");
  assert.equal(await harness.models.oneShot?.("system", "hello"), "mock one-shot reply to: hello");
  assert.equal("oneShot" in harness.turns, false);
  assert.equal("runTurn" in harness.models, false);
});
