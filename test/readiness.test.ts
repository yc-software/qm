import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testConfig } from "./support/test-config.ts";

async function fixture(checkReadiness?: (signal: AbortSignal) => Promise<void>) {
  const config = testConfig({ signingSecret: "readiness-test-source-secret".repeat(3) });
  const built = buildApp(config);
  const server = createServer(built.app, {
    ...serverDeps(config, built),
    ...(checkReadiness ? { checkReadiness } : {}),
    requireSignedPortalIdentity: true,
    portalIdentitySecret: "readiness-test-portal-secret".repeat(3),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get: (path: string) => fetch(`${url}${path}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("readiness is public and ready", async () => {
  const srv = await fixture();
  try {
    const response = await srv.get("/readyz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal((await srv.get("/healthz")).status, 200);
  } finally {
    await srv.close();
  }
});

test("readiness detects dependency loss and recovery without changing liveness or leaking errors", async () => {
  let available = true;
  let probes = 0;
  const srv = await fixture(async () => {
    probes++;
    if (!available) throw new Error("postgres://synthetic:secret@database.invalid/unavailable");
  });
  try {
    assert.equal((await srv.get("/readyz")).status, 200);
    available = false;
    const response = await srv.get("/readyz");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
    assert.equal((await srv.get("/healthz")).status, 200);
    assert.equal(probes, 2, "liveness must not touch the database");
    available = true;
    assert.equal((await srv.get("/readyz")).status, 200);
    assert.equal(probes, 3, "recovery must be checked, not cached");
  } finally {
    await srv.close();
  }
});

test("a stalled dependency is aborted within the readiness deadline while liveness stays responsive", async () => {
  let signal: AbortSignal | undefined;
  let recover = false;
  const srv = await fixture(async (s) => {
    signal = s;
    if (!recover) await new Promise(() => {});
  });
  try {
    const start = performance.now();
    const pending = srv.get("/readyz");
    const live = await srv.get("/healthz");
    assert.equal(live.status, 200);
    assert.ok(performance.now() - start < 500, "liveness must not wait for readiness");
    const response = await pending;
    assert.equal(response.status, 503);
    assert.ok(performance.now() - start < 2000, "readiness must return within two seconds");
    assert.deepEqual(await response.json(), { ok: false });
    assert.equal(signal?.aborted, true);
    recover = true;
    assert.equal((await srv.get("/readyz")).status, 200);
  } finally {
    await srv.close();
  }
});

test("readiness bounds a blackholed Postgres handshake and cleans up the pending connection", async () => {
  const sockets = new Set<Socket>();
  const blackhole = createTcpServer((socket) => sockets.add(socket));
  blackhole.listen(0, "127.0.0.1");
  await once(blackhole, "listening");
  const pg = createPgPool(`postgres://test:test@127.0.0.1:${(blackhole.address() as AddressInfo).port}/test`);
  const srv = await fixture(async (signal) => {
    await pg.q("SELECT 1", [], { signal });
  });
  try {
    const start = performance.now();
    const response = await srv.get("/readyz");
    assert.equal(response.status, 503);
    assert.ok(performance.now() - start < 2000);
    assert.deepEqual(await response.json(), { ok: false });
    assert.equal((await srv.get("/healthz")).status, 200);
  } finally {
    for (const socket of sockets) socket.destroy();
    await srv.close();
    await pg.close();
    await new Promise<void>((resolve) => blackhole.close(() => resolve()));
  }
});

test(
  "a stalled Postgres query discards its client and the next readiness probe recovers",
  {
    skip: !process.env.DATABASE_URL && "requires Postgres",
  },
  async () => {
    const pg = createPgPool(process.env.DATABASE_URL!);
    let slow = true;
    const srv = await fixture(async (signal) => {
      await pg.q(slow ? "SELECT pg_sleep(30)" : "SELECT 1", [], { signal });
    });
    try {
      const response = await srv.get("/readyz");
      assert.equal(response.status, 503);
      const sleeping = async () =>
        (
          await pg.q(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(30)' AND state = 'active'",
          )
        )[0]!.n;
      for (let i = 0; i < 50 && (await sleeping()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await sleeping(), 0, "a cancelled query must not keep running on the server");
      slow = false;
      assert.equal((await srv.get("/readyz")).status, 200);
    } finally {
      await srv.close();
      await pg.close();
    }
  },
);

test(
  "pool saturation fails readiness and a late acquired client is released before recovery",
  {
    skip: !process.env.DATABASE_URL && "requires Postgres",
  },
  async () => {
    const pg = createPgPool(process.env.DATABASE_URL!);
    const srv = await fixture(async (signal) => {
      await pg.q("SELECT 1", [], { signal });
    });
    const pool = await pg.pool();
    const reserveAll = () => Promise.all(Array.from({ length: pool.options.max }, () => pool.reserve()));
    const held = await reserveAll();
    try {
      const start = performance.now();
      assert.equal((await srv.get("/readyz")).status, 503);
      assert.ok(performance.now() - start < 2000);
      assert.equal((await srv.get("/healthz")).status, 200);
      for (const client of held.splice(0)) client.release();
      assert.equal((await srv.get("/readyz")).status, 200);
      const again = await Promise.race([reserveAll(), new Promise<null>((resolve) => setTimeout(resolve, 2000, null))]);
      assert.ok(again, "no late acquisition may leak a client");
      for (const client of again) client.release();
    } finally {
      for (const client of held) client.release();
      await srv.close();
      await pg.close();
    }
  },
);
