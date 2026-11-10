import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { baseModelProviders, configuredModel, providerKeysPresent } from "../src/config.ts";
import { defaultModel } from "../src/model/pi-models.ts";
import { testConfig } from "./support/test-config.ts";
import { stopAtEnd } from "./support/build-app.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
type Runtime = { modelId: string; effortLevel?: string; fastMode?: boolean };
type Body = { effective: Runtime; appEditRuntime?: Runtime };

function start(overrides: Parameters<typeof testConfig>[0]) {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "app-edit-runtime-")), ...overrides });
  const built = stopAtEnd(buildApp(config));
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    acl: built.acl,
    modelCredentials: built.modelCredentials,
    baseModelDefault: defaultModel(configuredModel(config), baseModelProviders(config)),
    providerKeys: providerKeysPresent(config),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function runtimeConfig(base: string): Promise<Body> {
  const res = await fetch(`${base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
  assert.equal(res.status, 200);
  return (await res.json()) as Body;
}

async function setAppEditRuntime(base: string, body: unknown): Promise<number> {
  const res = await fetch(`${base}/v1/admin/scopes/org:default-org/app-edit-runtime`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify(body),
  });
  return res.status;
}

test("app edit chats default to Sol Ultrafast, the org setting replaces it, and clearing it restores the default", async () => {
  const srv = start({ openaiApiKey: "deployment-openai-key", anthropicApiKey: "deployment-anthropic-key" });
  try {
    const before = await runtimeConfig(srv.base);
    assert.deepEqual(before.appEditRuntime, { modelId: "gpt-6.1-sol-ultrafast" });
    assert.notEqual(before.effective.modelId, "gpt-6.1-sol-ultrafast");
    assert.equal(await setAppEditRuntime(srv.base, { modelId: "gpt-6.1-sol", effortLevel: "high" }), 200);
    const set = await runtimeConfig(srv.base);
    assert.deepEqual(set.appEditRuntime, { modelId: "gpt-6.1-sol", effortLevel: "high" });
    assert.deepEqual(set.effective, before.effective);
    assert.equal(await setAppEditRuntime(srv.base, { inherit: true }), 200);
    assert.deepEqual((await runtimeConfig(srv.base)).appEditRuntime, { modelId: "gpt-6.1-sol-ultrafast" });
  } finally {
    await srv.close();
  }
});

test("a deployment that does not offer Sol Ultrafast falls back to the conversation runtime and logs why", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const srv = start({ anthropicApiKey: "deployment-anthropic-key" });
  try {
    const body = await runtimeConfig(srv.base);
    assert.equal(body.appEditRuntime, undefined);
    assert.ok(body.effective.modelId.startsWith("claude-"));
    const logged = warn.mock.calls.find((call) => String(call.arguments[0]).includes("app edit runtime unavailable"));
    assert.deepEqual(logged?.arguments[1], {
      modelId: "gpt-6.1-sol-ultrafast",
      reason: "not offered to this person on this deployment",
    });
  } finally {
    await srv.close();
  }
});
