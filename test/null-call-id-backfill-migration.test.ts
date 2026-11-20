import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { SESSION_MIGRATIONS } from "../src/sessions/session-schema.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const MIGRATIONS = ["sessions/store/0065-backfill-null-call-ids", "sessions/store/0066-tool-call-id-constraint"];

test("the backfill pairs legacy NULL call ids in order and forbids new NULL tool call ids", async () => {
  const url = testDatabaseUrl();
  const sessions = createPostgresSessionStore(url);
  const session = await sessions.getOrCreateByThread("web:null-call-backfill", "dm", scopeId("personal", "U1"));
  await sessions.appendMany({ sessionId: session.id }, [
    { kind: "ToolCall", tool: "execute", callId: "seed-1" },
    { kind: "ToolResult", tool: "execute", callId: "seed-1", text: "first" },
    { kind: "ToolCall", tool: "execute", callId: "seed-2" },
    { kind: "ToolResult", tool: "execute", callId: "seed-2", text: "second" },
    { kind: "ToolResult", tool: "execute", callId: "seed-3", text: "orphan" },
  ]);
  const raw = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await raw.query(
      "ALTER TABLE items DROP CONSTRAINT items_tool_call_id_present; ALTER TABLE items DISABLE TRIGGER items_append_only",
    );
    await raw.query("UPDATE items SET call_id = NULL WHERE session_id = $1", [session.id]);
    await raw.query("DELETE FROM qm_schema_migrations WHERE id = ANY($1)", [MIGRATIONS]);
    await applyPgMigrations(raw, SESSION_MIGRATIONS.filter((m) => MIGRATIONS.includes(m.id)).map(definePgMigration));
    const { rows } = await raw.query(
      "SELECT kind, call_id FROM items WHERE session_id = $1 AND kind IN ('ToolCall', 'ToolResult') ORDER BY seq",
      [session.id],
    );
    assert.match(rows[0]!.call_id, /^call_backfill_/);
    assert.deepEqual(
      rows.map((row) => row.call_id),
      [rows[0]!.call_id, rows[0]!.call_id, rows[2]!.call_id, rows[2]!.call_id, rows[4]!.call_id],
    );
    assert.equal(new Set(rows.map((row) => row.call_id)).size, 3);
    await raw.query("ALTER TABLE items DISABLE TRIGGER items_append_only");
    await assert.rejects(
      raw.query("UPDATE items SET call_id = NULL WHERE session_id = $1 AND kind = 'ToolCall'", [session.id]),
      /items_tool_call_id_present/,
    );
  } finally {
    await raw.end();
  }
});
