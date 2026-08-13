import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { generateEncodedKeyPair } from "../common/crypto.js";
import { createRelayServer } from "../relay/server.js";
import { MemoryRelayStore } from "../relay/store.js";

async function listen(store: MemoryRelayStore, options = {}) {
  const server = createRelayServer({ store, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function close(server: ReturnType<typeof createRelayServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("relay pairs a CLI and edge without returning raw secrets", async (t) => {
  const store = new MemoryRelayStore();
  const { server, base } = await listen(store, { pairingTtlMs: 2_000 });
  t.after(() => close(server));
  const cli = generateEncodedKeyPair();
  const edge = generateEncodedKeyPair();

  const createdResponse = await fetch(`${base}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cliPublicKey: cli.publicKey }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as {
    pairingId: string;
    code: string;
    cliToken: string;
  };

  const claimResponse = await fetch(`${base}/v1/pairings/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: created.code,
      edgePublicKey: edge.publicKey,
      deviceName: "Test laptop",
    }),
  });
  assert.equal(claimResponse.status, 200);
  const claimed = (await claimResponse.json()) as {
    deviceId: string;
    edgeToken: string;
    cliPublicKey: string;
  };
  assert.equal(claimed.cliPublicKey, cli.publicKey);

  const statusResponse = await fetch(`${base}/v1/pairings/${created.pairingId}`, {
    headers: { authorization: `Bearer ${created.cliToken}` },
  });
  const status = (await statusResponse.json()) as Record<string, unknown>;
  assert.deepEqual(status, {
    status: "paired",
    edgePublicKey: edge.publicKey,
    deviceName: "Test laptop",
  });
  assert.equal(JSON.stringify(status).includes(created.cliToken), false);
  assert.equal(JSON.stringify(status).includes(claimed.edgeToken), false);

  const unauthorized = await fetch(`${base}/v1/pairings/${created.pairingId}`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(unauthorized.status, 401);
});

test("expired pairings are durably cleaned and pairing admission is bounded", async (t) => {
  const store = new MemoryRelayStore();
  const { server, base } = await listen(store, {
    pairingTtlMs: 1,
    pairingRateLimit: 300,
    maxPendingPairingsPerSource: 300,
  });
  t.after(() => close(server));
  const cli = generateEncodedKeyPair();
  for (let index = 0; index < 300; index += 1) {
    const response = await fetch(`${base}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPublicKey: cli.publicKey }),
    });
    assert.equal(response.status, 201);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const limited = await fetch(`${base}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cliPublicKey: cli.publicKey }),
  });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
  await store.cleanup();
  assert.equal(store.pairingCount(), 0);
});

test("pending pairing admission has per-source and global caps", async (t) => {
  const store = new MemoryRelayStore();
  const { server, base } = await listen(store, {
    pairingTtlMs: 60_000,
    pairingRateLimit: 100,
    maxPendingPairingsPerSource: 2,
    maxPendingPairingsGlobal: 2,
  });
  t.after(() => close(server));
  const cli = generateEncodedKeyPair();
  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(`${base}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPublicKey: cli.publicKey }),
    });
    assert.equal(response.status, 201);
  }
  const rejected = await fetch(`${base}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cliPublicKey: cli.publicKey }),
  });
  assert.equal(rejected.status, 429);
});

test("claimed pairings cannot bypass total durable-state caps", async (t) => {
  const store = new MemoryRelayStore();
  const { server, base } = await listen(store, {
    pairingTtlMs: 60_000,
    pairingRateLimit: 100,
    maxPendingPairingsPerSource: 100,
    maxPendingPairingsGlobal: 100,
    maxPairingsPerSource: 2,
    maxPairingsGlobal: 2,
  });
  t.after(() => close(server));
  const cli = generateEncodedKeyPair();
  const edge = generateEncodedKeyPair();
  for (let index = 0; index < 2; index += 1) {
    const created = (await fetch(`${base}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPublicKey: cli.publicKey }),
    }).then((response) => response.json())) as { code: string };
    const claimed = await fetch(`${base}/v1/pairings/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: created.code,
        edgePublicKey: edge.publicKey,
        deviceName: `Attacker device ${index}`,
      }),
    });
    assert.equal(claimed.status, 200);
  }
  const rejected = await fetch(`${base}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cliPublicKey: cli.publicKey }),
  });
  assert.equal(rejected.status, 429);
});

test("accepted requests survive a relay restart through the shared store", async () => {
  const store = new MemoryRelayStore();
  const cli = generateEncodedKeyPair();
  const edge = generateEncodedKeyPair();
  const first = await listen(store, { requestTimeoutMs: 5_000 });
  const created = (await fetch(`${first.base}/v1/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cliPublicKey: cli.publicKey }),
  }).then((response) => response.json())) as {
    pairingId: string;
    code: string;
    cliToken: string;
  };
  const claimed = (await fetch(`${first.base}/v1/pairings/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: created.code,
      edgePublicKey: edge.publicKey,
      deviceName: "Restart laptop",
    }),
  }).then((response) => response.json())) as {
    deviceId: string;
    edgeToken: string;
  };
  const requestId = "782670cb-b78b-4bac-b444-194e3e40a3e1";
  const envelope = { version: 1 as const, iv: "iv", ciphertext: "cipher", tag: "tag" };
  const accepted = await fetch(`${first.base}/v1/pairings/${created.pairingId}/requests`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${created.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestId, envelope }),
  });
  assert.equal(accepted.status, 202);
  await close(first.server);

  const second = await listen(store, { requestTimeoutMs: 5_000 });
  try {
    const polled = await fetch(`${second.base}/v1/devices/${claimed.deviceId}/requests?wait=0`, {
      headers: { authorization: `Bearer ${claimed.edgeToken}` },
    });
    assert.equal(polled.status, 200);
    assert.equal(((await polled.json()) as { requestId: string }).requestId, requestId);
    const responded = await fetch(`${second.base}/v1/devices/${claimed.deviceId}/requests/${requestId}/response`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${claimed.edgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ envelope }),
    });
    assert.equal(responded.status, 204);
    const result = await fetch(`${second.base}/v1/pairings/${created.pairingId}/requests/${requestId}`, {
      headers: { authorization: `Bearer ${created.cliToken}` },
    });
    assert.equal(result.status, 200);
    assert.equal(((await result.json()) as { status: string }).status, "responded");
  } finally {
    await close(second.server);
  }
});
