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
import {
  createBackgroundOwnershipStore,
  type BackgroundOwnership,
  type BackgroundOwnershipControl,
} from "../src/runs/background-ownership.ts";

const sourceSecret = "source-only-secret".repeat(3);
const controlSecret = "operator-only-secret".repeat(3);
const TENANT = "00000000-0000-4000-8000-000000000001";
const path = `/v1/tenants/${TENANT}`;

async function fixture(
  secret: string | undefined,
  createTenant: (tenant: string) => Promise<{ tenant: string; created: boolean }>,
  backgroundOwnership?: BackgroundOwnershipControl,
) {
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    deploymentControlSecret: secret,
    createTenant,
    ...(backgroundOwnership ? { backgroundOwnership } : {}),
  });
  server.listen(0);
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  let nonce = 0;
  const request = (overrides: Record<string, string> = {}, target = path, body = "{}") => {
    const ts = Math.floor(Date.now() / 1000) + nonce++;
    return fetch(`${origin}${target}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(sourceSecret, ts, `PUT\n${target}\n${body}`),
        authorization: `Bearer ${controlSecret}`,
        ...overrides,
      },
      body,
    });
  };
  return { request, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("creating a tenant needs both the source signature and the operator credential, and a UUID", async () => {
  let calls = 0;
  const srv = await fixture(controlSecret, async (tenant) => {
    calls++;
    return { tenant, created: calls === 1 };
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
    assert.deepEqual(await created.json(), { tenant: TENANT, created: true });
    assert.deepEqual(await (await srv.request()).json(), { tenant: TENANT, created: false });
    const refused = await srv.request({}, "/v1/tenants/main");
    assert.equal(refused.status, 400);
    assert.equal(((await refused.json()) as { error: string }).error, "invalid_tenant");
    assert.equal(calls, 2);
  } finally {
    await srv.close();
  }
});

test("creating a tenant is unavailable without a distinct operator credential", async () => {
  const unavailable = await fixture(undefined, async () => ({ tenant: "t", created: false }));
  try {
    assert.equal((await unavailable.request()).status, 503);
  } finally {
    await unavailable.close();
  }
});

test("creating the first tenant names the answering deployment as background owner so turns run without another step", async () => {
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
