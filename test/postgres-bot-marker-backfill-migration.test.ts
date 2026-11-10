import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresUserStore } from "../src/identity/user-store.ts";
import { BACKFILL_BOT_MARKER_MIGRATION } from "../src/triggers/trigger-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("the bot marker backfill marks what a Slack app user made and nothing a person made", async () => {
  const url = testDatabaseUrl();
  const users = createPostgresUserStore(url);
  for (const id of ["release-bot", "U1"]) await users.record({ id, source: "turn", at: Date.now() });
  await users.markApps(["release-bot"]);
  const maps = createPostgresMapFactory(url);
  const creators = {
    crons: "createdBy",
    loops: "createdBy",
    monitors: "createdBy",
    keychain_asks: "requesterId",
  };
  for (const [table, creator] of Object.entries(creators)) {
    const map = maps.map<Record<string, unknown>>(table);
    await map.put("by-bot", { id: "by-bot", [creator]: "release-bot" });
    await map.put("by-person", { id: "by-person", [creator]: "U1" });
  }
  const pg = createPgPool(url);
  try {
    await pg.migrate(BACKFILL_BOT_MARKER_MIGRATION);
    for (const table of Object.keys(creators)) {
      const rows = await maps.map<{ id: string; botActor?: boolean }>(table).all();
      assert.deepEqual(
        Object.fromEntries(rows.map((row) => [row.id, row.botActor ?? null])),
        { "by-bot": true, "by-person": null },
        table,
      );
    }
  } finally {
    await pg.close();
  }
});
