import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl, testMap } from "./support/test-database.ts";
import { AmbiguousInstallTenant } from "../src/tenants/install.ts";
import {
  createBackgroundOwnershipStore,
  type BackgroundOwnership,
  type BackgroundOwnershipControl,
} from "../src/runs/background-ownership.ts";

const sourceSecret = "source-only-secret".repeat(3);
const controlSecret = "operator-only-secret".repeat(3);
const path = "/v1/install/tenant";

async function fixture(
  secret: string | undefined,
  installTenant: () => Promise<{ tenant: string; created: boolean }>,
  backgroundOwnership?: BackgroundOwnershipControl,
) {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    deploymentControlSecret: secret,
    installTenant,
    ...(backgroundOwnership ? { backgroundOwnership } : {}),
  });
  server.listen(0);
  const url = `http://localhost:${(server.address() as AddressInfo).port}${path}`;
  let nonce = 0;
  const request = (overrides: Record<string, string> = {}, body = "{}") => {
    const ts = Math.floor(Date.now() / 1000) + nonce++;
    return fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(sourceSecret, ts, `PUT\n${path}\n\n${body}`),
        authorization: `Bearer ${controlSecret}`,
        ...overrides,
      },
      body,
    });
  };
  return { request, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the install tenant route needs both the source signature and the operator credential", async () => {
  let calls = 0;
  const srv = await fixture(controlSecret, async () => {
    calls++;
    return { tenant: "00000000-0000-4000-8000-000000000001", created: calls === 1 };
  });
  try {
    const invalid: Record<string, string>[] = [
      { authorization: "" },
      { authorization: `Bearer ${sourceSecret}` },
      { "x-signature": "x" },
    ];
    for (const overrides of invalid) assert.equal((await srv.request(overrides)).status, 401);
    assert.equal(calls, 0);
    const created = await srv.request();
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { tenant: "00000000-0000-4000-8000-000000000001", created: true });
    assert.equal(calls, 1);
  } finally {
    await srv.close();
  }
});

test("the install tenant route is unavailable without a distinct operator credential", async () => {
  const unavailable = await fixture(undefined, async () => ({ tenant: "t", created: false }));
  try {
    assert.equal((await unavailable.request()).status, 503);
  } finally {
    await unavailable.close();
  }
});

test("the install tenant route refuses a database that holds several tenants", async () => {
  const tenants = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  const srv = await fixture(controlSecret, async () => {
    throw new AmbiguousInstallTenant(tenants);
  });
  try {
    const response = await srv.request();
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "ambiguous_install_tenant",
      message: "This database has 2 tenants; an install holds exactly one",
      tenants,
    });
  } finally {
    await srv.close();
  }
});

test("a fresh install names the answering deployment as background owner so turns run without another step", async () => {
  const store = createBackgroundOwnershipStore(testMap<BackgroundOwnership>());
  const control = { store, instanceId: "i", deploymentId: "core:fresh", active: () => true };
  const srv = await fixture(controlSecret, async () => ({ tenant: "t", created: true }), control);
  try {
    assert.equal((await store.get()).ownerDeploymentId, null);
    assert.equal((await srv.request()).status, 200);
    assert.equal((await store.get()).ownerDeploymentId, "core:fresh");
  } finally {
    await srv.close();
  }
});
