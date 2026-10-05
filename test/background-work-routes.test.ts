import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";
import { testConfig } from "./support/test-config.ts";

const sourceSecret = "source-only-secret".repeat(3);
const controlSecret = "deployment-only-secret".repeat(3);
const path = "/v1/background-work";

async function fixture(secret: string | undefined = controlSecret) {
  const store = createBackgroundOwnershipStore(createMemoryMap<BackgroundOwnership>());
  await store.set({ ownerDeploymentId: "cohort-a", setBy: "cohort-a" });
  let active = false;
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    requireSignedPortalIdentity: true,
    backgroundOwnership: { store, instanceId: "instance-b", deploymentId: "cohort-b", active: () => active },
    deploymentControlSecret: secret,
  });
  server.listen(0);
  const url = `http://localhost:${(server.address() as AddressInfo).port}${path}`;
  let nonce = 0;
  const request = async (method: string, body?: unknown, overrides: Record<string, string> = {}) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000) + nonce++;
    return fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(sourceSecret, ts, `${method}\n${path}\n${raw}`),
        authorization: `Bearer ${controlSecret}`,
        ...overrides,
      },
      ...(raw ? { body: raw } : {}),
    });
  };
  return {
    store,
    request,
    activate: () => {
      active = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const handover = () => ({ ownerDeploymentId: "cohort-b", expectedOwnerDeploymentId: "cohort-a" });

test("ownership controls require both source and distinct deployment credentials", async () => {
  const srv = await fixture();
  try {
    const invalidCredentials: Record<string, string>[] = [
      { authorization: "" },
      { authorization: `Bearer ${sourceSecret}` },
      { "x-signature": "invalid" },
    ];
    for (const credentials of invalidCredentials) {
      assert.equal((await srv.request("POST", handover(), credentials)).status, 401);
    }
    const capability = await mintCapabilityToken(
      { actorId: "U1", scopeId: scopeId("personal", "U1"), exp: Date.now() + CAPABILITY_TTL_MS },
      "capability-only-secret".repeat(3),
    );
    for (const method of ["GET", "POST"]) {
      const response = await srv.request(method, method === "POST" ? handover() : undefined, {
        "x-agent-capability": capability,
      });
      assert.equal(response.status, 403);
    }
    assert.equal((await srv.store.get()).ownerDeploymentId, "cohort-a");
    assert.equal((await srv.request("GET")).status, 200);
  } finally {
    await srv.close();
  }
  for (const secret of ["short", sourceSecret, "", " ".repeat(32)]) {
    const disabled = await fixture(secret);
    try {
      assert.equal((await disabled.request("GET")).status, 503);
    } finally {
      await disabled.close();
    }
  }
});

test("status reports the responder, the owner record, and the responder's activity", async () => {
  const srv = await fixture();
  try {
    const before = (await (await srv.request("GET")).json()) as Record<string, unknown>;
    assert.equal(before.protocol, 2);
    assert.equal(before.instanceId, "instance-b");
    assert.equal(before.deploymentId, "cohort-b");
    assert.equal(before.ownerDeploymentId, "cohort-a");
    assert.equal(before.setBy, "cohort-a");
    assert.equal(typeof before.setAt, "string");
    assert.equal(before.active, false);
    srv.activate();
    const response = await srv.request("POST", handover());
    assert.equal(response.status, 200);
    const status = (await response.json()) as Record<string, unknown>;
    assert.equal(status.ownerDeploymentId, "cohort-b");
    assert.equal(status.setBy, "cohort-b");
    assert.equal(status.active, true);
    assert.deepEqual(Object.keys(status).sort(), [
      "active",
      "deploymentId",
      "instanceId",
      "ownerDeploymentId",
      "protocol",
      "setAt",
      "setBy",
    ]);
  } finally {
    await srv.close();
  }
});

test("compare-and-swap rejects stale expectations while retries and pauses succeed", async () => {
  const srv = await fixture();
  try {
    assert.equal((await srv.request("POST", { ...handover(), expectedOwnerDeploymentId: null })).status, 409);
    assert.equal((await srv.store.get()).ownerDeploymentId, "cohort-a");
    assert.equal((await srv.request("POST", handover())).status, 200);
    assert.equal((await srv.request("POST", handover())).status, 200);
    assert.equal(
      (await srv.request("POST", { ownerDeploymentId: "cohort-a", expectedOwnerDeploymentId: "cohort-c" })).status,
      409,
    );
    assert.equal((await srv.request("POST", { ownerDeploymentId: null })).status, 200);
    assert.equal((await srv.store.get()).ownerDeploymentId, null);
  } finally {
    await srv.close();
  }
});

test("malformed mutations cannot change ownership", async () => {
  const srv = await fixture();
  try {
    for (const body of [
      null,
      {},
      { ownerDeploymentId: 3 },
      { ownerDeploymentId: "" },
      { ownerDeploymentId: "x".repeat(2049) },
      { ...handover(), extra: true },
      { ...handover(), expectedOwnerDeploymentId: 7 },
      { expectedGeneration: 0, requestId: "legacy", desiredDeploymentId: "cohort-b" },
    ])
      assert.equal((await srv.request("POST", body)).status, 400);
    assert.equal((await srv.store.get()).ownerDeploymentId, "cohort-a");
  } finally {
    await srv.close();
  }
});
