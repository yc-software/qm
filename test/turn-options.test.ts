import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NON_INTERACTIVE_FAST_MODE,
  NON_INTERACTIVE_THINKING_LEVEL,
  turnModelOptions,
  validateWebTurnModelOptions,
} from "../src/core/turn-options.ts";

test("triggered turns default to extra-high thinking and non-fast mode", () => {
  assert.deepEqual(turnModelOptions({ triggered: true }), {
    thinkingLevel: NON_INTERACTIVE_THINKING_LEVEL,
    fastMode: NON_INTERACTIVE_FAST_MODE,
  });
});

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

test("a triggered turn with an explicit low thinking level overrides the xhigh trigger default", () => {
  assert.deepEqual(turnModelOptions({ triggered: true, thinkingLevel: "low" }), {
    thinkingLevel: "low",
    fastMode: NON_INTERACTIVE_FAST_MODE,
  });
});
