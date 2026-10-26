import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { getRequiredModel } from "../src/model/pi-models.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const MODEL_ID = "unregistered-future-model";

test("unknown builtin-provider model fails resolution and a live runtime selection request", async () => {
  assert.throws(() => getRequiredModel(MODEL_ID), /Unsupported model/);
  const config = testConfig();
  const built = buildApp(config, {
    modelCredentialFetch: async () => Response.json({ data: [] }),
  });
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        principalId: "admin-alice@default-org",
        scopeId: "personal:admin-alice@default-org",
        modelId: MODEL_ID,
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(JSON.stringify(body), /model|supported/);
    console.log(`Baseline: unknown model resolution throws; live runtime selection HTTP ${response.status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
