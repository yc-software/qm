import { test } from "node:test";
import assert from "node:assert/strict";
import { DROP_RUN_AS_MIGRATION } from "../src/cron/cron-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the cron run-mode migration test";

test("dropping run modes hands floor crons to their conversation and strips mode fields", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  try {
    await pool.query("DROP TABLE IF EXISTS crons, loops");
    for (const sql of DROP_RUN_AS_MIGRATION.statements.slice(0, 2)) await pool.query(sql);
    const members = [{ id: "alice", type: "internal" }];
    const crons = {
      floor: { owner: "alice", ownerScopeId: "channel:C1", runAs: "scopeFloor", members },
      floorLoop: { owner: "alice", ownerScopeId: "channel:C1", runAs: "scopeFloor", loopId: "L1" },
      floorPersonal: { owner: "alice", ownerScopeId: "personal:alice", runAs: "scopeFloor" },
      shared: {
        owner: "alice",
        ownerScopeId: "group:G1",
        runAs: "scopeShared",
        ownerResourcesRequireOpen: true,
        members,
      },
      owner: { owner: "alice", ownerScopeId: "channel:C1", runAs: "owner" },
    };
    for (const [id, json] of Object.entries(crons))
      await pool.query("INSERT INTO crons (id, json) VALUES ($1, $2)", [id, JSON.stringify({ id, ...json })]);
    await pool.query("INSERT INTO loops (id, json) VALUES ('L1', $1)", [
      JSON.stringify({ id: "L1", runAs: "scopeFloor" }),
    ]);

    for (const run of [1, 2]) {
      for (const sql of DROP_RUN_AS_MIGRATION.statements) await pool.query(sql);
      const rows: Record<string, Record<string, unknown>> = Object.fromEntries(
        (await pool.query("SELECT id, json FROM crons")).rows.map((row) => [row.id, row.json]),
      );
      assert.equal(rows.floor?.owner, "system:channel:C1", `run ${run}`);
      assert.equal(rows.floorLoop?.owner, "alice", "a loop's cron keeps the loop's owner");
      assert.equal(rows.floorPersonal?.owner, "alice");
      assert.equal(rows.shared?.owner, "alice");
      for (const row of Object.values(rows)) {
        assert.equal(row.runAs, undefined);
        assert.equal(row.members, undefined);
        assert.equal(row.ownerResourcesRequireOpen, undefined);
      }
      assert.deepEqual((await pool.query("SELECT json FROM loops")).rows[0].json, { id: "L1" });
    }
  } finally {
    await pool.end();
  }
});
