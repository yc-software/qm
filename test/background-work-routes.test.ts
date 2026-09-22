import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  await store.register({ instanceId: "instance-a", deploymentId: "cohort-a", taskArn: "task-a" });
  await store.register({ instanceId: "instance-b", deploymentId: "cohort-b", taskArn: "task-b" });
  await store.admit("instance-a", 0, true);
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    requireSignedPortalIdentity: true,
    backgroundOwnership: { store, instanceId: "instance-b", deploymentId: "cohort-b" },
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
  return { store, request, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const transition = () => ({
  expectedGeneration: 0,
  requestId: randomUUID(),
  desiredDeploymentId: "cohort-b",
  bootstrapTaskArns: ["task-a", "task-b"],
});

test("ownership controls require both source and distinct deployment credentials", async () => {
  const srv = await fixture();
  try {
    const invalidCredentials: Record<string, string>[] = [
      { authorization: "" },
      { authorization: `Bearer ${sourceSecret}` },
      { "x-signature": "invalid" },
    ];
    for (const credentials of invalidCredentials) {
      assert.equal((await srv.request("POST", transition(), credentials)).status, 401);
    }
    const capability = await mintCapabilityToken(
      { actorId: "U1", scopeId: scopeId("personal", "U1"), exp: Date.now() + CAPABILITY_TTL_MS },
      "capability-only-secret".repeat(3),
    );
    for (const method of ["GET", "POST"]) {
      const response = await srv.request(method, method === "POST" ? transition() : undefined, {
        "x-agent-capability": capability,
      });
      assert.equal(response.status, 403);
    }
    assert.equal((await srv.store.get()).generation, 0);
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

test("authenticated transitions report exact responder identity, preserve retry identity, and reject stale generations", async () => {
  const srv = await fixture();
  try {
    const change = transition();
    const response = await srv.request("POST", change);
    assert.equal(response.status, 200);
    const status = (await response.json()) as Record<string, unknown>;
    assert.equal(status.protocol, 1);
    assert.equal(status.instanceId, "instance-b");
    assert.equal(status.deploymentId, "cohort-b");
    assert.equal(status.generation, 1);
    assert.equal(status.lastRequestId, change.requestId);
    assert.equal(status.lastRequest, undefined);
    assert.equal((await srv.request("POST", change)).status, 200);
    assert.equal((await srv.request("POST", transition())).status, 409);
    const retired = await srv.request("POST", {
      expectedGeneration: 1,
      requestId: randomUUID(),
      terminatedMembers: [{ instanceId: "instance-a", taskArn: "wrong-task", generation: 0 }],
    });
    assert.equal(retired.status, 409);
    const pause = await srv.request("POST", {
      expectedGeneration: 1,
      requestId: randomUUID(),
      desiredDeploymentId: null,
    });
    assert.equal(pause.status, 200);
    assert.equal((await srv.store.get()).desiredDeploymentId, null);
  } finally {
    await srv.close();
  }
});

test("malformed or mixed mutations cannot change ownership", async () => {
  const srv = await fixture();
  try {
    for (const body of [
      null,
      { ...transition(), expectedGeneration: -1 },
      { ...transition(), requestId: "invalid" },
      { ...transition(), desiredDeploymentId: 3 },
      { ...transition(), extra: true },
      { ...transition(), bootstrapTaskArns: [] },
      { ...transition(), terminatedMembers: [] },
      {
        expectedGeneration: 0,
        requestId: randomUUID(),
        terminatedMembers: [{ instanceId: "instance-a", taskArn: "task-a", generation: -1 }],
      },
      { expectedGeneration: 0, requestId: randomUUID() },
    ])
      assert.equal((await srv.request("POST", body)).status, 400);
    assert.equal((await srv.store.get()).generation, 0);
    const retired = await srv.request("POST", {
      expectedGeneration: 0,
      requestId: randomUUID(),
      terminatedMembers: [{ instanceId: "instance-a", taskArn: "task-a", generation: 0 }],
    });
    assert.equal(retired.status, 200);
    assert.equal((await srv.store.get()).members.find((member) => member.instanceId === "instance-a")?.retired, true);
  } finally {
    await srv.close();
  }
});

test("compensation request preconditions are enforced atomically through the authenticated route", async () => {
  const srv = await fixture();
  try {
    const promotion = transition();
    assert.equal((await srv.request("POST", promotion)).status, 200);
    const compensation = {
      expectedGeneration: 1,
      expectedLastRequestId: promotion.requestId,
      requestId: randomUUID(),
      desiredDeploymentId: null,
    };
    const retirement = {
      expectedGeneration: 1,
      requestId: randomUUID(),
      terminatedMembers: [{ instanceId: "instance-a", taskArn: "task-a", generation: 0 }],
    };
    assert.equal((await srv.request("POST", retirement)).status, 200);
    assert.equal((await srv.request("POST", compensation)).status, 409);
    assert.equal((await srv.request("POST", { ...compensation, expectedLastRequestId: 123 })).status, 400);
    const current = { ...compensation, expectedLastRequestId: retirement.requestId };
    assert.equal((await srv.request("POST", current)).status, 200);
    assert.equal((await srv.request("POST", current)).status, 200);
    assert.equal((await srv.store.get()).generation, 2);
  } finally {
    await srv.close();
  }
});
