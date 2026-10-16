import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresAutomationRunStore } from "../src/triggers/run-store.ts";

const databaseUrl = process.env.DATABASE_URL;

test(
  "webhook receipts migrate once into run history without replacing canonical results",
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      await pool.query(`CREATE TABLE webhook_history (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
      await pool.query(`CREATE TABLE cron_fires (
      cron_id TEXT NOT NULL, fire_key TEXT NOT NULL, thread_ref TEXT NOT NULL,
      session_id TEXT, fired_at BIGINT NOT NULL, scheduled_at BIGINT, ended_at BIGINT,
      status TEXT, note TEXT, reply TEXT, payload TEXT, delivery_id TEXT,
      PRIMARY KEY (cron_id, fire_key)
    )`);
      await pool.query("INSERT INTO webhook_history VALUES ($1, $2)", [
        "hook",
        JSON.stringify({
          events: [
            { deliveryId: "old", receivedAt: 100, payload: "original payload" },
            { deliveryId: "completed", receivedAt: 200, payload: "legacy payload" },
          ],
        }),
      ]);
      await pool.query(`INSERT INTO cron_fires (cron_id, fire_key, thread_ref, fired_at, ended_at, status, reply, payload, delivery_id)
      VALUES ('webhook:hook', 'webhook:hook:completed', 'webhook:hook:completed', 200, 250, 'ok', 'done', 'canonical payload', 'completed')`);
      const store = createPostgresAutomationRunStore(databaseUrl!);
      const history = await store.listByCron("webhook:hook");
      assert.equal(history.total, 2);
      assert.deepEqual(history.runs[0], {
        fireKey: "webhook:hook:old",
        threadRef: "webhook:hook:old",
        firedAt: 100,
        payload: "original payload",
        deliveryId: "old",
      });
      assert.equal(history.runs[1]?.status, "ok");
      assert.equal(history.runs[1]?.reply, "done");
      assert.equal(history.runs[1]?.payload, "canonical payload");
      assert.equal((await pool.query("SELECT to_regclass('webhook_history') AS name")).rows[0].name, null);
      const restarted = createPostgresAutomationRunStore(databaseUrl!);
      assert.deepEqual(await restarted.listByCron("webhook:hook"), history);
    } finally {
      await pool.end();
    }
  },
);
