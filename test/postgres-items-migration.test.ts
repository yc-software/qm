import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId, type EntryType, type SessionEntry } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the items upgrade test";

test(
  "pg upgrade from a pre-items release: startup migrations copy history into items, then drop the legacy tables",
  { skip },
  async () => {
    const pg = (await import("pg")).default;
    const raw = new pg.Pool({ connectionString: URL });
    try {
      createPostgresSessionStore(URL!);
      const migrations = registeredPgMigrations(URL!);
      await applyPgMigrations(
        raw,
        migrations.filter((migration) => migration.id < "sessions/store/0035-items"),
      );
      const sessionId = randomUUID();
      const scope = scopeId("personal", "alice");
      const runId = randomUUID();
      const longCallId = `call__thought__${"x".repeat(1100)}`;
      const legacy: [EntryType, Record<string, unknown>][] = [
        ["user", { text: "hello", name: "Alice", principalId: "alice", runId }],
        ["thinking", { text: "hmm", thinkingSignature: "sig" }],
        ["text", { text: "narrating" }],
        ["tool_call", { tool: "execute", callId: "c1", input: { command: "ls" } }],
        ["tool_result", { tool: "execute", callId: "c1", result: "out\n", stdout: "out\n" }],
        ["assistant", { text: "final answer" }],
        ["system", { kind: "goal", goal: { objective: "x", status: "active" } }],
        ["assistant", { text: "cron says hi", deliveryKey: "cron:1", via: "cron" }],
        ["delivery", { text: "a.txt (text/plain, 3 bytes)", files: ["a.txt"] }],
        ["user", { text: "steer", steered: true }],
        ["system", { kind: "turn_failure", message: "boom", runId }],
        ["system", { kind: "wake", cause: "cron", text: "cron fired" }],
        ["soul" as EntryType, { text: "you are" }],
        ["text_start" as EntryType, { phase: "final_answer" }],
        ["system", { kind: "goal_cancelled", objective: "Example goal", cancelledBy: "alice" }],
        ["tool_call", { tool: "execute", callId: longCallId, input: { command: "pwd" } }],
        ["tool_call", { tool: "execute", callId: "c1", input: { command: "ls" } }],
      ];
      await raw.query(
        "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, messages) VALUES ($1, 'dm', $2, 'web:cutover', 1, $3)",
        [sessionId, scope, legacy.length],
      );
      await raw.query(
        "INSERT INTO participants(session_id, principal_id, valid_from, valid_from_seq) VALUES ($1, 'alice', 0, 0)",
        [sessionId],
      );
      const legacyEntries: SessionEntry[] = [];
      for (const [seq, [type, payload]] of legacy.entries()) {
        await raw.query(
          `INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [sessionId, seq, seq ? seq - 1 : null, type, JSON.stringify(payload), scope, 1_000 + seq],
        );
        legacyEntries.push({
          sessionId,
          seq,
          parentSeq: seq ? seq - 1 : null,
          type,
          payload,
          scopeLabel: scope,
          createdAt: 1_000 + seq,
        });
      }

      await applyPgMigrations(raw, migrations);
      await applyPgMigrations(raw, migrations);

      const store = createPostgresSessionStore(URL!);
      const copied = await store.getEntries(sessionId);
      assert.deepEqual(copied.at(-3)?.payload, {
        kind: "goal_cancelled",
        cause: "system",
        objective: "Example goal",
        cancelledBy: "alice",
      });
      assert.equal((copied[0]!.payload as { text: string }).text, "hello");
      assert.equal((copied.find((entry) => entry.seq === 5)!.payload as { text: string }).text, "final answer");
      assert.equal((copied.find((entry) => entry.seq === 4)!.payload as { result: string }).result, "out\n");
      assert.deepEqual(
        copied
          .filter((entry) => entry.type === "tool_call")
          .map((entry) => (entry.payload as { callId: string }).callId),
        ["c1", longCallId, "c1"],
        "call ids too long or repeated for the call_id column stay in the copied body",
      );
      assert.deepEqual(
        copied.map((entry) => [entry.seq, entry.type, entry.createdAt]),
        legacyEntries
          .filter((entry) => !["soul", "text_start"].includes(entry.type))
          .filter((entry) => (entry.payload as { kind?: string }).kind !== "goal")
          .map((entry) => [entry.seq, entry.type, entry.createdAt]),
      );
      assert.deepEqual(
        (await raw.query("SELECT seq, turn_id::text FROM items WHERE turn_id IS NOT NULL ORDER BY seq")).rows,
        [
          { seq: "0", turn_id: runId },
          { seq: "10", turn_id: runId },
        ],
      );

      const legacyTables = await raw.query(
        `SELECT name FROM unnest(ARRAY['session_entries', 'legacy_session_entries', 'session_entry_search',
           'session_tape', 'legacy_tape_steps', 'legacy_turn_runs', 'legacy_tape_steps_progress']) AS name
          WHERE to_regclass(name) IS NOT NULL`,
      );
      assert.deepEqual(legacyTables.rows, [], "every legacy history table is dropped");
      const leftovers = await raw.query(
        `SELECT proname FROM pg_proc WHERE pronamespace = current_schema()::regnamespace
            AND proname IN ('entry_search_text', 'sync_item_search', 'items_copy_payload')
          UNION ALL SELECT tgname FROM pg_trigger WHERE tgrelid = 'items'::regclass AND tgname = 'session_entry_search'`,
      );
      assert.deepEqual(leftovers.rows, [], "legacy search and copy functions and triggers are dropped");

      const { lease } = await store.acquireLease(sessionId);
      assert.ok(lease);
      const next = await store.append(lease, {
        type: "assistant",
        payload: { text: "first answer after cutover zebracorn" },
        scopeLabel: scope,
      });
      await store.releaseLease(lease);
      assert.equal(next.seq, legacy.length);
      assert.deepEqual(
        (await store.searchEntries("alice", "zebracorn")).map((hit) => [hit.sessionId, hit.seq]),
        [[sessionId, legacy.length]],
        "search reads items",
      );
      assert.deepEqual(
        (await store.searchEntries("alice", "final answer")).map((hit) => [hit.seq, hit.type]),
        [[5, "assistant"]],
        "copied history is searchable",
      );

      await assert.rejects(
        raw.query("UPDATE items SET body = '{}' WHERE session_id = $1", [sessionId]),
        /UPDATE on items is forbidden/,
      );
      await assert.rejects(
        raw.query("DELETE FROM items WHERE session_id = $1", [sessionId]),
        /only allowed through its session/,
      );
      await assert.rejects(raw.query("TRUNCATE items"), /TRUNCATE on items is forbidden/);
      await raw.query(
        "INSERT INTO blobs(tenant_id, sha256, size, mime, storage_key, created_at) VALUES (qm_tenant_id(), decode(repeat('00', 32), 'hex'), 1, 'text/plain', 'k', now())",
      );
      await assert.rejects(raw.query("UPDATE blobs SET size = 2"), /UPDATE on blobs is forbidden/);

      await store.deleteSession(sessionId);
      assert.equal(Number((await raw.query("SELECT count(*) FROM items")).rows[0].count), 0);
    } finally {
      await raw.end();
    }
  },
);
