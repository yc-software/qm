import { test } from "node:test";
import assert from "node:assert/strict";
import { turnModelOptions, validateWebTurnModelOptions } from "../src/core/turn-options.ts";

test("explicit turn model options win over triggered defaults", () => {
  assert.deepEqual(turnModelOptions({ triggered: true, thinkingLevel: "low", fastMode: true }), {
    thinkingLevel: "low",
    fastMode: true,
  });
});

test("web model controls are bounded by admin configuration", () => {
  assert.equal(
    validateWebTurnModelOptions({ model: "claude-sonnet-4-6" }, ["claude-opus-4-8"]),
    "that model is not enabled for the web UI",
  );
  assert.equal(validateWebTurnModelOptions({ thinkingLevel: "infinite" }, null), "unsupported thinking level");
  assert.equal(validateWebTurnModelOptions({ model: "claude-opus-4-8", thinkingLevel: "high" }, null), null);
});

test("interactive turns do not force model options", () => {
  assert.deepEqual(turnModelOptions({}), {});
});
