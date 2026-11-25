import { test } from "node:test";
import assert from "node:assert/strict";
import { DROP_RETIRED_TRIGGER_FIELDS_MIGRATION } from "../src/triggers/trigger-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the retired trigger fields migration test";

test("dropping retired trigger fields strips them from every trigger table and keeps the rest", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  const tables = ["crons", "webhooks", "loops", "monitors"];
  try {
    await pool.query(`DROP TABLE IF EXISTS ${tables.join(", ")}`);
    for (const table of tables) {
      await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
      await pool.query(`INSERT INTO ${table} (id, json) VALUES ('pending', $1), ('plain', $2)`, [
        JSON.stringify({
          id: "pending",
          enabled: true,
          destination: { type: "principal", target: "U2" },
          recipientConsent: { recipientId: "U2", status: "pending" },
          taskAuthor: "automation",
          ownerConsentedAt: 1,
        }),
        JSON.stringify({ id: "plain", enabled: true }),
      ]);
    }

    for (const run of [1, 2]) {
      for (const sql of DROP_RETIRED_TRIGGER_FIELDS_MIGRATION.statements) await pool.query(sql);
      for (const table of tables) {
        const rows = Object.fromEntries(
          (await pool.query(`SELECT id, json FROM ${table}`)).rows.map((row) => [row.id, row.json]),
        );
        assert.deepEqual(
          rows.pending,
          { id: "pending", enabled: true, destination: { type: "principal", target: "U2" } },
          `${table} run ${run}`,
        );
        assert.deepEqual(rows.plain, { id: "plain", enabled: true }, `${table} run ${run}`);
      }
    }
  } finally {
    await pool.end();
  }
});
