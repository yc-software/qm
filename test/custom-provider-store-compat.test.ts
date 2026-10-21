import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { customModelsJson, resolveCustomModel, setCustomProviders } from "../src/model/custom-providers.ts";

afterEach(() => setCustomProviders([]));

test("Gemini OpenAI-compatible custom models disable store in runtime and provider registration", () => {
  setCustomProviders([
    {
      id: "gemini",
      name: "Gemini",
      protocol: "openai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      models: [{ id: "gemini-3.8-flash" }],
    },
  ]);

  const model = resolveCustomModel("custom/gemini/gemini-3.8-flash");
  assert.deepEqual(model?.compat, { supportsStore: false });

  const registration = customModelsJson()?.providers.gemini as {
    models: Array<{ compat?: { supportsStore?: boolean } }>;
  };
  assert.deepEqual(registration.models[0]?.compat, { supportsStore: false });
});

test("other OpenAI-compatible custom providers keep their default store behavior", () => {
  setCustomProviders([
    {
      id: "acme",
      name: "Acme",
      protocol: "openai",
      baseUrl: "https://llm.acme.example/v1",
      models: [{ id: "acme-large" }],
    },
  ]);

  const model = resolveCustomModel("custom/acme/acme-large");
  assert.equal(model?.compat, undefined);

  const registration = customModelsJson()?.providers.acme as {
    models: Array<{ compat?: { supportsStore?: boolean } }>;
  };
  assert.equal(registration.models[0]?.compat, undefined);
});
