import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { runEventRoutes } from "../../../src/api/routes/run-events.ts";
import { type ApiCtx, respond } from "../../../src/api/routes/route.ts";
import type { App } from "../../../src/api/app.ts";
import { configurePgTenancy, createPgPool, type PgPool } from "../../../src/persistence/pg-pool.ts";
import { createPostgresNotifyBus } from "../../../src/persistence/postgres-notify-bus.ts";
import { emitRunText, type RunStreamEvent } from "../../../src/runs/run-stream-events.ts";
import { createPostgresRunSignalStore } from "../../../src/runs/postgres-run-signal-store.ts";
import { createTurnStream } from "../../../src/runs/turn-stream.ts";
import { tenant, tenantFor, withTenant, type Tenant } from "../../../src/tenant.ts";

const URL_ADMIN = process.env.DATABASE_URL;
const skip = URL_ADMIN ? false : "set DATABASE_URL (a Postgres) to run the tenant run-stream test";
const DB = `qm_mt_stream_${process.pid}`;
const ROLE = "qm_mt_stream_app";

let admin: pg.Client;
let appUrl = "";

before(async () => {
  if (!URL_ADMIN) return;
  admin = new pg.Client({ connectionString: URL_ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
  );
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  const url = new URL(URL_ADMIN);
  url.username = ROLE;
  url.password = ROLE;
  url.pathname = `/${DB}`;
  appUrl = url.toString();
  configurePgTenancy(true);
});

after(async () => {
  if (!URL_ADMIN) return;
  configurePgTenancy(false);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

function tenantApp(t: Tenant, db: PgPool, channel: string) {
  return withTenant(t, () => {
    const bus = createPostgresNotifyBus<RunStreamEvent>(appUrl, channel, `run-stream ${t.orgId}`);
    const stream = createTurnStream({
      onDelta: (runId, text, offset, startOffset) => emitRunText(bus, runId, text, offset, startOffset),
      onChange: (runId) => bus.emit({ runId, kind: "refresh" }),
    });
    const stopSync = bus.subscribe((event) => {
      if (event.kind !== "sync") return;
      const text = stream.snapshot(event.runId);
      const start = stream.startOffset(event.runId);
      const offset = Math.max(event.offset, start);
      if (text) emitRunText(bus, event.runId, text.slice(offset - start), offset, start);
    });
    const app = {
      async getRun(runId: string) {
        const [row] = await db.q(`SELECT status FROM stream_runs WHERE id = $1`, [runId]);
        if (!row) return null;
        return { status: row.status, attempt: 1, startedAt: 0, finishedAt: null, result: null };
      },
      subscribeRun(runId: string, listener: (event: RunStreamEvent) => void, onResync?: () => void) {
        return bus.subscribe((event) => event.runId === runId && listener(event), { onResync });
      },
      syncRunStream(runId: string, offset: number) {
        bus.emit({ runId, kind: "sync", offset });
      },
      async getRunToolItems() {
        return [];
      },
    } as unknown as Pick<App, "getRun" | "getRunToolItems" | "subscribeRun" | "syncRunStream">;
    return { tenant: t, bus, stream, app, stop: stopSync };
  });
}

test(
  "a non-home tenant's live run stream receives deltas over the LISTEN connection the home tenant opened",
  { skip, timeout: 20_000 },
  async () => {
    const db = createPgPool(appUrl, [
      {
        id: "tenant-run-stream-test/0001",
        statements: [`CREATE TABLE stream_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL)`],
      },
    ]);
    await db.pool();
    const channel = `run_stream_${randomUUID().replaceAll("-", "")}`;
    const home = tenantApp(tenantFor("home"), db, channel);
    const kitten = tenantApp(tenantFor("kittens", randomUUID(), "kittens"), db, channel);
    const runId = randomUUID();
    await withTenant(kitten.tenant, () =>
      db.query(`INSERT INTO stream_runs(id, status) VALUES ($1, 'running')`, [runId]),
    );
    const seenIn: (string | undefined)[] = [];
    const offProbe = withTenant(kitten.tenant, () => kitten.bus.subscribe(() => seenIn.push(tenant().id)));
    const server: Server = createServer((req, res) =>
      withTenant(kitten.tenant, () => {
        void respond(runEventRoutes[0]!.handle, {
          app: kitten.app,
          req,
          res,
          params: { id: runId },
        } as unknown as ApiCtx);
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      let wire = "";
      const sawText = Promise.withResolvers<void>();
      const consume = (async () => {
        while (true) {
          const next = await reader.read().catch(() => ({ done: true as const, value: undefined }));
          if (next.done) return;
          wire += new TextDecoder().decode(next.value);
          if (/"name":"delta".*tenant/s.test(wire)) sawText.resolve();
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 200));

      await withTenant(kitten.tenant, async () => {
        kitten.stream.begin(runId);
        await new Promise((resolve) => setTimeout(resolve, 100));
        kitten.stream.publish(runId, "hello ");
        kitten.stream.publish(runId, "tenant");
      });
      const outcome = await Promise.race([
        sawText.promise.then(() => "delta"),
        consume.then(() => "stream closed"),
        new Promise((resolve) => setTimeout(() => resolve("timed out"), 5_000)),
      ]);
      assert.equal(outcome, "delta", `live text should reach the browser; wire was: ${wire}`);
      assert.ok(seenIn.length > 0, "the probe saw notifications");
      assert.ok(
        seenIn.every((id) => id === kitten.tenant.id),
        "notifications run in the subscribing tenant's context",
      );
    } finally {
      controller.abort();
      offProbe();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const app of [kitten, home]) {
        app.stop();
        await app.bus.close?.();
      }
      await db.close();
    }
  },
);

test("run signal wakeups run in the waiting tenant's context", { skip, timeout: 20_000 }, async () => {
  const home = tenantFor("home");
  const kittens = tenantFor("kittens", randomUUID(), "kittens");
  const homeSignals = withTenant(home, () => createPostgresRunSignalStore(appUrl));
  const signals = withTenant(kittens, () => createPostgresRunSignalStore(appUrl));
  const offHome = withTenant(home, () => homeSignals.onSignal(randomUUID(), () => {}));
  const runId = randomUUID();
  const wokeIn: (string | undefined)[] = [];
  const found = Promise.withResolvers<void>();
  const off = withTenant(kittens, () =>
    signals.onSignal(runId, () => {
      wokeIn.push(tenant().id);
      void signals.pending(runId).then((rows) => rows.length > 0 && found.resolve());
    }),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await withTenant(kittens, () => signals.send(runId, { kind: "steer", text: "hi" }));
    const outcome = await Promise.race([
      found.promise.then(() => "found"),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 3_000)),
    ]);
    assert.equal(outcome, "found", "the wakeup reads the waiting tenant's signal");
    assert.ok(wokeIn.length > 0 && wokeIn.every((id) => id === kittens.id));
  } finally {
    off();
    offHome();
    await signals.close?.();
    await homeSignals.close?.();
  }
});
