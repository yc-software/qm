import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRuntime } from "../src/model/model-runtime.ts";
import { DEFAULT_AGENT_MODEL_ID, getRequiredModel } from "../src/model/pi-models.ts";
import { withTenant } from "../src/tenants/context.ts";
import { TEST_TENANT } from "./support/tenant.ts";

test("the model runtime never authenticates with provider keys from the process environment", async () => {
  const saved = { anthropic: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY };
  process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
  process.env.OPENAI_API_KEY = "env-openai-key";
  try {
    await withTenant(TEST_TENANT, async () => {
      const model = getRequiredModel(DEFAULT_AGENT_MODEL_ID, false);
      const keyless = await buildModelRuntime({});
      assert.equal(keyless.hasConfiguredAuth("anthropic"), false);
      assert.equal(keyless.hasConfiguredAuth("openai"), false);
      assert.equal(await keyless.getAuth(model), undefined);
      const keyed = await buildModelRuntime({ anthropic: "tenant-key" });
      assert.equal((await keyed.getAuth(model))?.auth.apiKey, "tenant-key");
      assert.equal(keyed.hasConfiguredAuth("openai"), false);
    });
  } finally {
    for (const [name, value] of [
      ["ANTHROPIC_API_KEY", saved.anthropic],
      ["OPENAI_API_KEY", saved.openai],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
