import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const oxAlphaCatalog: typeof fetch = async () =>
  Response.json({
    data: [
      {
        id: "stealth/ox-alpha",
        name: "Ox Alpha",
        context_length: 1_048_576,
        pricing: { prompt: "0", completion: "0" },
        top_provider: { max_completion_tokens: 131_072 },
        architecture: { input_modalities: ["text", "image", "video"] },
        supported_parameters: ["tools", "reasoning", "reasoning_effort"],
      },
    ],
  });

test("web turns hydrate persisted OpenRouter catalog models before runtime resolution", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "dynamic-openrouter-model-")),
      openrouterApiKey: "deployment-openrouter-key",
    }),
    { modelCredentialFetch: oxAlphaCatalog },
  );
  await built.config.setRuntimeSelectionLatest("org:default-org", {
    harnessId: "pi",
    modelId: "stealth/ox-alpha",
  });

  const turn = await built.app.turn({
    surface: "web",
    actor: { externalId: "alice" },
    conversation: { kind: "dm", threadRef: "web:alice:dynamic-openrouter-model" },
    text: "hello",
    model: "stealth/ox-alpha",
    async: true,
  });
  assert.equal(turn.status, "queued");
});
