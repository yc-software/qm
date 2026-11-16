import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeConfigBody, turnModelRefusal } from "../src/api/runtime-config.ts";
import type { AppDeps } from "../src/api/app-types.ts";
import { orgScope } from "../src/config.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { scopeId, type ScopeId, type TurnRequest } from "../src/types.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("the web picker offers exactly the models a web turn accepts", async () => {
  const custom = "custom/acme/acme-large";
  setCustomProviders([
    { id: "acme", name: "Acme", protocol: "openai", baseUrl: "https://acme.test/v1", models: [{ id: "acme-large" }] },
  ]);
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "picker-parity-")) }));
  const deps = {
    config: built.config,
    providerKeys: { anthropic: true, openai: true, openrouter: false },
  } as unknown as AppDeps;
  const scope = scopeId("personal", "alice");
  const send = (model: string) =>
    turnModelRefusal(
      deps,
      { surface: "web", model, conversation: { kind: "dm" } } as unknown as TurnRequest,
      "alice",
      false,
      undefined,
    );
  try {
    const offered = await runtimeConfigBody({ deps }, scope);
    assert.ok(offered.models.includes(custom));
    for (const model of offered.models) assert.equal(await send(model), null, `${model} is offered but refused`);
    await built.config.setWebuiModels(orgScope() as ScopeId, [offered.orgDefault.modelId]);
    await built.config.setRuntimeSelection(scope, { modelId: custom });
    const restricted = await runtimeConfigBody({ deps }, scope);
    assert.deepEqual(restricted.models, [offered.orgDefault.modelId]);
    assert.ok(restricted.unavailableReason);
    assert.match((await send(custom)) ?? "", /not enabled/);
  } finally {
    setCustomProviders([]);
    await built.runtime.stop();
  }
});
