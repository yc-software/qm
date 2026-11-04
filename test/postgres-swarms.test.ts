import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createSwarmStore, SWARM_LIMITS, type SwarmStorage } from "../src/swarms/swarm-store.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

const baseUrl = process.env.DATABASE_URL;
const schema = `swarm_test_${process.pid}`;
const isolatedUrl = baseUrl ? new URL(baseUrl) : undefined;
isolatedUrl?.searchParams.set("options", `-c search_path=${schema}`);
const databaseUrl = isolatedUrl?.toString();
before(async () => {
  if (!baseUrl) return;
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: baseUrl });
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await pool.end();
  }
});
after(async () => {
  if (!baseUrl) return;
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: baseUrl });
  try {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  } finally {
    await pool.end();
  }
});
const skip = databaseUrl ? false : "set DATABASE_URL to a disposable Postgres database";

test("Postgres pending selection retains one live query across sweep timeouts", { skip }, async (context) => {
  const factory = createPostgresMapFactory(databaseUrl!);
  const backing = factory.map<SwarmStorage>("swarms");
  const store = createSwarmStore(backing);
  const { service } = await swarmFixture({ store });
  await backing.select({ limit: 1 });
  const pool = await factory.pool.sessionPool();
  const blocker = await pool.connect();
  const observer = await pool.connect();
  const waiting = async (): Promise<number> => {
    const result = await observer.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1",
      ["SELECT tenant_id, id, json FROM swarms%"],
    );
    return result.rows[0]!.count;
  };
  const pending = store.pending.bind(store);
  let selections = 0;
  let selection: ReturnType<typeof pending> | undefined;
  store.pending = (afterId) => {
    selections++;
    selection = pending(afterId);
    return selection;
  };
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE swarms IN ACCESS EXCLUSIVE MODE");
    context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    for (let iteration = 0; iteration < 6; iteration++) {
      const sweep = assert.rejects(service.sweep(), /swarm pending batch timed out/);
      for (let attempt = 0; attempt < 100 && (await waiting()) === 0; attempt++) await sleep(5);
      context.mock.timers.tick(SWARM_LIMITS.reconcileMs + 1);
      await sweep;
      assert.equal(selections, 1);
      assert.equal(await waiting(), 1);
    }
    await blocker.query("ROLLBACK");
    await selection;
    context.mock.timers.reset();
    await service.sweep();
    assert.equal(selections, 2);
    assert.equal(await waiting(), 0);
  } finally {
    context.mock.timers.reset();
    await blocker.query("ROLLBACK");
    await selection;
    blocker.release();
    observer.release();
    await factory.pool.close();
  }
});

