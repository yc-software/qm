import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";
import { testConfig } from "./support/test-config.ts";

const source = "source-only-secret".repeat(3);
const control = "deployment-only-secret".repeat(3);

async function fixture() {
  let ready = false;
  let promoted = 0;
  const gate = Promise.withResolvers<void>();
  const built = buildApp(testConfig({ signingSecret: source }));
  const store = createBackgroundOwnershipStore(createMemoryMap<BackgroundOwnership>());
  const server = createServer(built.app, {
    signingSecret: source,
    portalIdentitySecret: "portal-identity-secret".repeat(3),
    capabilitySecret: "capability-only-secret".repeat(3),
    requireSignedPortalIdentity: true,
    backgroundOwnership: { store, instanceId: "instance-new", deploymentId: "core:new", active: () => false },
    deploymentControlSecret: control,
    itemsPromotion: {
      ready: () => ready,
      preflight: async () => {},
      refresh: async () => ready,
      promote: async () => {
        promoted++;
        ready = true;
        gate.resolve();
      },
      wait: () => gate.promise,
      close: async () => {},
    },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  let nonce = 0;
  return {
    promoted: () => promoted,
    release: () => {
      ready = true;
      gate.resolve();
    },
    get: (path: string) => fetch(base + path),
    request: async (method: string, body?: unknown, headers: Record<string, string> = {}) => {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const ts = Math.floor(Date.now() / 1000) + nonce++;
      const path = "/v1/items-promotion";
      return fetch(base + path, {
        method,
        headers: {
          "content-type": "application/json",
          "x-timestamp": String(ts),
          "x-signature": signRequest(source, ts, `${method}\n${path}\n${raw}`),
          authorization: `Bearer ${control}`,
          ...headers,
        },
        ...(raw ? { body: raw } : {}),
      });
    },
    close: () => {
      gate.resolve();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("staged HTTP holds business requests but remains live and not ready", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get("/healthz")).status, 200);
    assert.equal((await f.get("/readyz")).status, 503);
    let responded = false;
    const held = f.get("/v1/sessions").then((r) => {
      responded = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(responded, false);
    f.release();
    assert.equal((await held).status, 401);
    assert.equal((await f.get("/readyz")).status, 200);
  } finally {
    await f.close();
  }
});

test("promotion requires source plus deployment credentials and an exact target", async () => {
  const f = await fixture();
  const body = { writersStopped: true, deploymentId: "core:new" };
  try {
    assert.equal((await f.request("POST", body, { authorization: "" })).status, 401);
    assert.equal((await f.request("POST", body, { "x-signature": "wrong" })).status, 401);
    for (const bad of [
      {},
      { ...body, writersStopped: false },
      { ...body, deploymentId: "core:old" },
      { ...body, extra: true },
    ])
      assert.equal((await f.request("POST", bad)).status, 400);
    assert.equal(f.promoted(), 0);
    assert.deepEqual(await (await f.request("GET")).json(), { deploymentId: "core:new", ready: false });
    assert.equal((await f.request("POST", body)).status, 200);
    assert.equal(f.promoted(), 1);
  } finally {
    await f.close();
  }
});
