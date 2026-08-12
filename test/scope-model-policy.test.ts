import test from "node:test";
import assert from "node:assert/strict";
import { parseScopeModelPolicy } from "../src/model/scope-model-policy.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { resolveRuntimeChoice } from "../src/harness/harness-router.ts";

const ORG = "org:acme";
const PERSONAL = "personal:alice";
const PROJECT = "group:web-project-one";

const policy = parseScopeModelPolicy(
  {
    version: 1,
    scopes: {
      [ORG]: { models: ["claude-sonnet-5", "gpt-5.6-luna"], default: "claude-sonnet-5" },
      [PERSONAL]: { models: ["claude-opus-5"], default: "claude-opus-5" },
      [PROJECT]: { models: ["gpt-5.6-sol"], default: "gpt-5.6-sol" },
      "team:engineering": { models: ["claude-haiku-4-5"] },
    },
  },
  ORG,
);

test("model scope policy combines the org with only the active scope", () => {
  assert.deepEqual(policy.resolve(PERSONAL), {
    models: ["claude-sonnet-5", "gpt-5.6-luna", "claude-opus-5"],
    defaultModel: "claude-opus-5",
  });
  assert.deepEqual(policy.resolve(PROJECT), {
    models: ["claude-sonnet-5", "gpt-5.6-luna", "gpt-5.6-sol"],
    defaultModel: "gpt-5.6-sol",
  });
  assert.equal(policy.allows(PROJECT, "claude-opus-5"), false);
  assert.equal(policy.allows(PROJECT, "claude-sonnet-5"), true);
});

test("model scope policy defaults to scope, org, then first allowed model", () => {
  const withoutDefaults = parseScopeModelPolicy(
    {
      version: 1,
      scopes: {
        [ORG]: { models: ["claude-sonnet-5"] },
        [PROJECT]: { models: ["gpt-5.6-sol"] },
      },
    },
    ORG,
  );
  assert.equal(withoutDefaults.resolve(PROJECT).defaultModel, "claude-sonnet-5");

  const scopeDefault = parseScopeModelPolicy(
    {
      version: 1,
      scopes: {
        [ORG]: { models: ["claude-sonnet-5"] },
        [PROJECT]: { models: ["gpt-5.6-sol"], default: "gpt-5.6-sol" },
      },
    },
    ORG,
  );
  assert.equal(scopeDefault.resolve(PROJECT).defaultModel, "gpt-5.6-sol");
});

test("runtime policy selects its default and rejects direct disallowed requests", () => {
  const config = createMemoryConfigStore("acme");
  config.setApprovedHarnesses(["pi"]);
  config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-haiku-4-5" });
  const fallback = { harnessId: "pi" as const, modelId: "claude-haiku-4-5" };

  assert.deepEqual(resolveRuntimeChoice(config, ORG, PROJECT, fallback, undefined, policy), {
    harnessId: "pi",
    modelId: "gpt-5.6-sol",
  });
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, PROJECT, fallback, { modelId: "claude-opus-5" }, policy),
    /not enabled/,
  );
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PROJECT, fallback, { modelId: "claude-sonnet-5" }, policy), {
    harnessId: "pi",
    modelId: "claude-sonnet-5",
  });
});

test("invalid policy defaults fail closed", () => {
  assert.throws(
    () =>
      parseScopeModelPolicy(
        { version: 1, scopes: { [ORG]: { models: ["claude-sonnet-5"], default: "gpt-5.6-sol" } } },
        ORG,
      ),
    /default must appear/,
  );
  assert.throws(() => parseScopeModelPolicy({ version: 2, scopes: {} }, ORG), /version must be 1/);
});
