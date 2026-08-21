import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import pg from "pg";
import { generateEncodedKeyPair } from "../common/crypto.js";
import { PostgresRelayStore } from "../relay/postgres-store.js";
import { createRelayServer } from "../relay/server.js";

const databaseUrl = process.env.INWISE_QM_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const skip = databaseUrl ? false : "set DATABASE_URL to run Postgres relay tests";

async function reset(): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query(`
    DROP TABLE IF EXISTS inwise_relay_requests CASCADE;
    DROP TABLE IF EXISTS inwise_pairing_rate_limits CASCADE;
    DROP TABLE IF EXISTS inwise_pairings CASCADE;
  `);
  await pool.end();
}

async function start() {
  const server = createRelayServer({
    store: new PostgresRelayStore(databaseUrl!),
    requestTimeoutMs: 5_000,
    pairingTtlMs: 5_000,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function stop(server: ReturnType<typeof createRelayServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("Postgres relay shares accepted request lifecycle across instances", { skip }, async () => {
  await reset();
  const cli = generateEncodedKeyPair();
  const edge = generateEncodedKeyPair();
  const a = await start();
  const b = await start();
  try {
    const created = (await fetch(`${a.base}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPublicKey: cli.publicKey }),
    }).then((response) => response.json())) as {
      pairingId: string;
      code: string;
      cliToken: string;
    };
    const claimed = (await fetch(`${b.base}/v1/pairings/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: created.code,
        edgePublicKey: edge.publicKey,
        deviceName: "Shared laptop",
      }),
    }).then((response) => response.json())) as {
      deviceId: string;
      edgeToken: string;
    };
    const requestId = "356d084c-4b9e-46c4-a845-7a92486a6088";
    const envelope = { version: 1 as const, iv: "iv", ciphertext: "cipher", tag: "tag" };
    const accepted = await fetch(`${a.base}/v1/pairings/${created.pairingId}/requests`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${created.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requestId, envelope }),
    });
    assert.equal(accepted.status, 202);
    await stop(a.server);

    const polled = await fetch(`${b.base}/v1/devices/${claimed.deviceId}/requests?wait=0`, {
      headers: { authorization: `Bearer ${claimed.edgeToken}` },
    });
    assert.equal(polled.status, 200);
    const responded = await fetch(`${b.base}/v1/devices/${claimed.deviceId}/requests/${requestId}/response`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${claimed.edgeToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ envelope }),
    });
    assert.equal(responded.status, 204);
    const result = await fetch(`${b.base}/v1/pairings/${created.pairingId}/requests/${requestId}`, {
      headers: { authorization: `Bearer ${created.cliToken}` },
    });
    assert.equal(result.status, 200);
    assert.equal(((await result.json()) as { status: string }).status, "responded");
  } finally {
    if (a.server.listening) await stop(a.server);
    await stop(b.server);
    await reset();
  }
});

test("Postgres pairing admission removes expired rows and rate limits globally", { skip }, async () => {
  await reset();
  const store = new PostgresRelayStore(databaseUrl!);
  await store.initialize();
  const admission = {
    sourceKey: "203.0.113.5",
    maxPerWindow: 300,
    windowMs: 60_000,
    maxPendingPerSource: 300,
    maxPendingGlobal: 300,
    maxTotalPerSource: 300,
    maxTotalGlobal: 300,
  };
  try {
    for (let index = 0; index < 300; index += 1) {
      await store.createPairing(`key-${index}`, 1, admission);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      () => store.createPairing("one-more", 60_000, admission),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 429,
    );
    await store.cleanup();
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM inwise_pairings");
    await pool.end();
    assert.equal(result.rows[0]?.count, "0");
  } finally {
    await store.close();
    await reset();
  }
});
