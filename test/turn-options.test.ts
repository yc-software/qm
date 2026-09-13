import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  NON_INTERACTIVE_FAST_MODE,
  NON_INTERACTIVE_THINKING_LEVEL,
  turnModelOptions,
  validateWebTurnModelOptions,
} from "../src/core/turn-options.ts";
import { defaultWebuiModelIds } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

afterEach(() => setCustomProviders([]));

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

test("the web-turn fallback allowlist includes live custom-provider models", () => {
  setCustomProviders([
    {
      id: "acme-gateway",
      name: "Acme Gateway",
      protocol: "openai",
      baseUrl: "https://llm.acme.internal/v1",
      models: [{ id: "acme-large", name: "Acme Large" }],
    },
  ]);
  assert.ok(defaultWebuiModelIds().includes("acme-large"));
  assert.equal(validateWebTurnModelOptions({ model: "acme-large" }, null), null);
  assert.equal(
    validateWebTurnModelOptions({ model: "acme-large" }, ["claude-opus-4-8"]),
    "that model is not enabled for the web UI",
  );
});

test("a triggered turn with an explicit low thinking level overrides the xhigh trigger default", () => {
  assert.deepEqual(turnModelOptions({ triggered: true, thinkingLevel: "low" }), {
    thinkingLevel: "low",
    fastMode: NON_INTERACTIVE_FAST_MODE,
  });
});
