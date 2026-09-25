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
import { createMemoryReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testConfig } from "./support/test-config.ts";

const sourceSecret = "source-only-secret".repeat(3);
const controlSecret = "deployment-only-secret".repeat(3);
const path = "/v1/deployment/live-session";

async function fixture(run: () => Promise<void> = async () => {}) {
  const store = createBackgroundOwnershipStore(createMemoryMap<BackgroundOwnership>());
  await store.register({ instanceId: "instance-a", deploymentId: "cohort-a", taskArn: "task-a" });
  await store.transition({
    expectedGeneration: 0,
    requestId: randomUUID(),
    desiredDeploymentId: "cohort-a",
    bootstrapTaskArns: ["task-a"],
  });
  await store.admit("instance-a", 1, false);
  await store.markReady("instance-a", 1);
  const dedupe = createMemoryReplayDedupe();
  const built = buildApp(testConfig({ signingSecret: sourceSecret }));
  const server = createServer(built.app, {
    signingSecret: sourceSecret,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    requireSignedPortalIdentity: true,
    backgroundOwnership: { store, instanceId: "instance-a", deploymentId: "cohort-a" },
    deploymentControlSecret: controlSecret,
    deploymentLiveSmoke: run,
    replayDedupe: { durable: true, claim: (...args) => dedupe.claim(...args) },
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

const body = () => ({
  requestId: randomUUID(),
  expectedDeploymentId: "cohort-a",
  expectedGeneration: 1,
  expectedTaskArns: ["task-a"],
});

test("live smoke requires distinct credentials, rejects capabilities and arbitrary inputs", async () => {
  let calls = 0;
  const srv = await fixture(async () => {
    calls++;
  });
  try {
    const invalidCredentials: Record<string, string>[] = [
      { authorization: "" },
      { authorization: `Bearer ${sourceSecret}` },
      { "x-signature": "invalid" },
    ];
    for (const credentials of invalidCredentials) {
      assert.equal((await srv.request("POST", body(), credentials)).status, 401);
    }
    const capability = await mintCapabilityToken(
      { actorId: "U1", scopeId: scopeId("personal", "U1"), exp: Date.now() + CAPABILITY_TTL_MS },
      "capability-only-secret".repeat(3),
    );
    assert.equal((await srv.request("POST", body(), { "x-agent-capability": capability })).status, 403);
    for (const request of [
      null,
      { ...body(), url: "https://untrusted.invalid" },
      { ...body(), expectedTaskArns: [] },
      { ...body(), expectedTaskArns: ["task-a", "task-a"] },
      { ...body(), expectedDeploymentId: "other" },
    ]) {
      assert.equal((await srv.request("POST", request)).status, 400);
    }
    for (const request of [
      { ...body(), expectedGeneration: 2 },
      { ...body(), expectedTaskArns: ["different"] },
    ]) {
      assert.equal((await srv.request("POST", request)).status, 409);
    }
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test("live smoke returns exact identity and rejects request replay", async () => {
  let calls = 0;
  const srv = await fixture(async () => {
    calls++;
  });
  try {
    const request = body();
    const response = await srv.request("POST", request);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    assert.deepEqual(await response.json(), {
      ok: true,
      requestId: request.requestId,
      deploymentId: "cohort-a",
      instanceId: "instance-a",
      taskArn: "task-a",
      generation: 1,
    });
    assert.equal((await srv.request("POST", request)).status, 409);
    assert.equal(calls, 1);
  } finally {
    await srv.close();
  }
});

test("live smoke keeps singleflight through client disconnect and cleanup", async () => {
  let release!: () => void;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let calls = 0;
  const srv = await fixture(async () => {
    calls++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    finished();
  });
  try {
    const response = await srv.request("POST", body());
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value).trim(), "");
    assert.equal(new TextDecoder().decode((await reader.read()).value).trim(), "");
    await reader.cancel();
    assert.equal((await srv.request("POST", body())).status, 409);
    assert.equal(calls, 1);
    release();
    await done;
  } finally {
    release?.();
    await srv.close();
  }
});

test("live smoke fails when ownership changes and never returns raw errors", async () => {
  const srv = await fixture(async () => {
    await srv.store.transition({ expectedGeneration: 1, requestId: randomUUID(), desiredDeploymentId: null });
  });
  try {
    const result = (await (await srv.request("POST", body())).json()) as { ok: boolean; error: string };
    assert.equal(result.ok, false);
    assert.equal(result.error, "deployment_smoke_ownership_changed");
  } finally {
    await srv.close();
  }
  const failed = await fixture(async () => {
    throw new Error("secret-value-do-not-expose");
  });
  try {
    const response = await failed.request("POST", body());
    const raw = await response.text();
    assert.equal(JSON.parse(raw).error, "deployment_smoke_failed");
    assert.ok(!raw.includes("secret-value"));
  } finally {
    await failed.close();
  }
});
