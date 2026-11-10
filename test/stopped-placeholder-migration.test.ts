import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { SESSION_MIGRATIONS } from "../src/sessions/session-schema.ts";
import { applyPgMigrations, definePgMigration } from "../src/persistence/pg-pool.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("the cleanup drops placeholder replies recorded right after a Stop and nothing else", async () => {
  const url = testDatabaseUrl();
  const sessions = createPostgresSessionStore(url);
  const session = await sessions.getOrCreateByThread("web:stopped-cleanup", "dm", scopeId("personal", "U1"));
  const writer = { sessionId: session.id };
  await sessions.appendMany(writer, [
    { kind: "UserMessage", text: "first" },
    { kind: "Stop", body: { reason: "by user" } },
    { kind: "AgentMessage", text: "(stopped)", body: {} },
    { kind: "UserMessage", text: "second" },
    { kind: "AgentMessage", text: "(stopped)", body: {} },
    { kind: "Stop", body: { reason: "by user" } },
    { kind: "AgentMessage", text: "Partial answer", body: {} },
  ]);
  const raw = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await raw.query("DELETE FROM qm_schema_migrations WHERE id = 'sessions/store/0057-drop-stopped-placeholders'");
    await applyPgMigrations(
      raw,
      SESSION_MIGRATIONS.filter((m) => m.id === "sessions/store/0057-drop-stopped-placeholders").map(definePgMigration),
    );
    await assert.rejects(raw.query("DELETE FROM items WHERE session_id = $1", [session.id]), /only allowed through/);
  } finally {
    await raw.end();
  }
  assert.deepEqual(
    (await sessions.getItems(session.id)).map((item) => [item.kind, item.text ?? null]),
    [
      ["UserMessage", "first"],
      ["Stop", null],
      ["UserMessage", "second"],
      ["AgentMessage", "(stopped)"],
      ["Stop", null],
      ["AgentMessage", "Partial answer"],
    ],
  );
});
