import { test } from "node:test";
import assert from "node:assert/strict";
import { LOOPS_TO_CRONS_MIGRATION } from "../src/cron/cron-store.ts";
import { renderSourceInboxTask } from "../src/inbox/sync-task.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the loops-to-crons migration test";

test("loops become crons with an inbox and keep their items", { skip }, async () => {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  try {
    await pool.query("DROP TABLE IF EXISTS crons, loops, loop_items, cron_items");
    for (const sql of LOOPS_TO_CRONS_MIGRATION.statements.slice(0, 4)) await pool.query(sql);
    const loops = {
      repairs: {
        name: "Error repairs",
        state: "enabled",
        cronId: "c-repairs",
        playbook: "GET $AGENT_API_URL/v1/loops/$LOOP_ID/items then POST /v1/loops/repairs/items for $LOOP_ID",
      },
      paused: { name: "Paused work", state: "paused", cronId: "c-paused", playbook: "work" },
      mail: { name: "Email", state: "enabled", surface: "inbox:gmail", cronId: "c-mail", playbook: "old" },
      legacy: { name: "Inbox", state: "archived", surface: "inbox", cronId: "c-legacy", playbook: "old" },
      unscheduled: { name: "Never scheduled", state: "paused", playbook: "idle" },
    };
    const crons = {
      "c-repairs": { title: "Loop: Error repairs", enabled: true, action: "Loop: Error repairs", loopId: "repairs" },
      "c-paused": { title: "Loop: Paused work", enabled: true, action: "Loop: Paused work", loopId: "paused" },
      "c-mail": { title: "Email sync", enabled: true, action: "Inbox sync v7", loopId: "mail" },
      "c-legacy": { title: "Inbox sync", enabled: false, action: "Inbox sync v6", loopId: "legacy" },
      "c-plain": { title: "Daily digest", enabled: true, action: "digest" },
    };
    const items = {
      i1: { loopId: "repairs", sourceKey: "E-1", status: "in_progress", attempts: 2, claimToken: "t", triage: {} },
      i2: { loopId: "mail", sourceKey: "thread-1", status: "ready", proposal: { data: { body: "hi" } } },
      i3: { loopId: "legacy", sourceKey: "thread-0", status: "ready" },
      i4: { loopId: "unscheduled", sourceKey: "x", status: "queued" },
    };
    for (const [table, rows] of [
      ["loops", loops],
      ["crons", crons],
      ["loop_items", items],
    ] as const)
      for (const [id, json] of Object.entries(rows))
        await pool.query(`INSERT INTO ${table} (id, json) VALUES ($1, $2)`, [id, JSON.stringify({ id, ...json })]);

    for (const run of [1, 2]) {
      for (const sql of LOOPS_TO_CRONS_MIGRATION.statements) await pool.query(sql);
      const cronRows: Record<string, Record<string, unknown>> = Object.fromEntries(
        (await pool.query("SELECT id, json FROM crons")).rows.map((row) => [row.id, row.json]),
      );
      assert.deepEqual(Object.keys(cronRows).sort(), ["c-mail", "c-paused", "c-plain", "c-repairs"], `run ${run}`);
      for (const row of Object.values(cronRows)) assert.equal(row.loopId, undefined);
      assert.deepEqual(cronRows["c-repairs"], {
        id: "c-repairs",
        title: "Error repairs",
        enabled: true,
        inbox: {},
        action: "GET $AGENT_API_URL/v1/crons/c-repairs/items then POST /v1/crons/c-repairs/items for c-repairs",
      });
      assert.equal(cronRows["c-paused"]!.enabled, false);
      assert.deepEqual(cronRows["c-mail"]!.inbox, { source: "gmail" });
      assert.equal(cronRows["c-mail"]!.title, "Email sync");
      assert.equal(cronRows["c-mail"]!.action, renderSourceInboxTask("gmail"));
      assert.deepEqual(cronRows["c-plain"], { id: "c-plain", ...crons["c-plain"] });

      const itemRows: Record<string, Record<string, unknown>> = Object.fromEntries(
        (await pool.query("SELECT id, json FROM cron_items")).rows.map((row) => [row.id, row.json]),
      );
      assert.deepEqual(Object.keys(itemRows).sort(), ["i1", "i2"]);
      assert.deepEqual(itemRows.i1, { id: "i1", cronId: "c-repairs", sourceKey: "E-1", status: "queued" });
      assert.deepEqual(itemRows.i2, {
        id: "i2",
        cronId: "c-mail",
        sourceKey: "thread-1",
        status: "ready",
        proposal: { data: { body: "hi" } },
      });
    }
  } finally {
    await pool.end();
  }
});
