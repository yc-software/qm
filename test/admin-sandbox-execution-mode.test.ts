import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";

test("admin creation requires explicit isolated mode and the owning scope flag without changing existing computers", async (t) => {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "sandbox-modes-")), sandboxResourcesEnabled: true });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
  const scope = "personal:admin-alice@default-org";
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const create = (executionMode?: string) =>
    fetch(`${base}/v1/admin/sandboxes/${encodeURIComponent(scope)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" },
      body: JSON.stringify({ action: "create", backend: "sprites", ...(executionMode ? { executionMode } : {}) }),
    });
  const denied = await create("isolated");
  assert.equal(denied.status, 400);
  assert.match(((await denied.json()) as { message: string }).message, /command_scoped_credentials/);
  await built.featureFlags.setEnabled("command_scoped_credentials", scope, true, "admin");
  const legacyResponse = await create();
  assert.equal(legacyResponse.status, 201, await legacyResponse.clone().text());
  const legacy = (await legacyResponse.json()) as { id: string; executionMode: string };
  assert.equal(legacy.executionMode, "legacy");
  const isolatedResponse = await create("isolated");
  assert.equal(isolatedResponse.status, 201, await isolatedResponse.clone().text());
  const isolated = (await isolatedResponse.json()) as { id: string; executionMode: string };
  assert.equal(isolated.executionMode, "isolated");
  await built.featureFlags.setEnabled("command_scoped_credentials", scope, false, "admin");
  const layers = [{ scopeId: scope, mode: "rw" as const, mountPath: "/" }];
  assert.equal((await built.sandbox.provision(layers, { sandboxId: legacy.id })).executionMode, "legacy");
  assert.equal((await built.sandbox.provision(layers, { sandboxId: isolated.id })).executionMode, "isolated");
  assert.equal((await create("isolated")).status, 400);
  assert.equal((await create("unsupported")).status, 400);
});
