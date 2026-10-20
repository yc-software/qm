import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { ItemsCopyOperator } from "../scripts/ops/items-copy.ts";
import { ITEM_INDEXES } from "../src/sessions/items-schema.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the items cutover test";

test(
  "pg items cutover: live copy, catchup, online indexes and finish hand off promoted columns to E",
  { skip },
  async () => {
    const pg = (await import("pg")).default;
    const admin = new pg.Pool({ connectionString: URL });
    const raw = new pg.Pool({ connectionString: URL });
    const client = new pg.Client({ connectionString: URL });
    await client.connect();
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
      const legacy: [string, Record<string, unknown>][] = [
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
        ["soul", { text: "you are" }],
        ["text_start", { phase: "final_answer" }],
        ["system", { kind: "goal_cancelled", objective: "Example goal", cancelledBy: "alice" }],
      ];
      await raw.query(
        "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at, messages) VALUES ($1, 'dm', $2, 'web:cutover', 1, $3)",
        [sessionId, scope, legacy.length],
      );
      await raw.query(
        "INSERT INTO participants(session_id, principal_id, valid_from, valid_from_seq) VALUES ($1, 'alice', 0, 0)",
        [sessionId],
      );
      for (const [seq, [type, payload]] of legacy.entries()) {
        await raw.query(
          `INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [sessionId, seq, seq ? seq - 1 : null, type, JSON.stringify(payload), scope, 1_000 + seq],
        );
      }

      const op = new ItemsCopyOperator(client, 3);
      await op.prepare();
      while (await op.copyBatch()) continue;
      await op.completeCopy();
      await raw.query("UPDATE session_entries SET payload=$1 WHERE session_id=$2 AND seq=5", [
        JSON.stringify({ text: "updated final answer" }),
        sessionId,
      ]);
      while (await op.catchupBatch()) continue;
      await op.verify();
      await assert.rejects(op.finish(true), /build the items indexes/);
      await op.indexes();
      assert.equal(
        (await raw.query("SELECT count(*)::int AS n FROM pg_index WHERE indrelid='items'::regclass AND indisvalid"))
          .rows[0].n,
        ITEM_INDEXES.length + 1,
      );
      await op.finish(true);
      await applyPgMigrations(raw, migrations);
      await op.cleanup();
      assert.equal((await raw.query("SELECT to_regnamespace('items_copy_ops') AS n")).rows[0].n, null);

      const store = createPostgresSessionStore(URL!);
      const copied = await store.getItems(sessionId);
      const last = copied.at(-1)!;
      assert.equal(last.kind, "Wake");
      assert.equal(last.wakeCause, "system");
      assert.deepEqual(last.body, { kind: "goal_cancelled", objective: "Example goal", cancelledBy: "alice" });
      assert.equal(copied[0]!.text, "hello");
      assert.equal(copied.find((item) => item.seq === 5)!.text, "updated final answer");
      assert.equal(copied.find((item) => item.seq === 4)!.text, "out\n");
      assert.equal(copied.find((item) => item.seq === 3)!.callId, "c1");
      assert.deepEqual(
        copied.map((item) => [item.seq, item.kind, item.variant, item.createdAt]),
        [
          [0, "UserMessage", null, 1_000],
          [1, "Reasoning", null, 1_001],
          [2, "AgentMessage", "narration", 1_002],
          [3, "ToolCall", null, 1_003],
          [4, "ToolResult", null, 1_004],
          [5, "AgentMessage", null, 1_005],
          [7, "AgentMessage", null, 1_007],
          [8, "AgentMessage", "files_delivered", 1_008],
          [9, "SteeringMessage", null, 1_009],
          [10, "Error", null, 1_010],
          [11, "Wake", null, 1_011],
          [14, "Wake", null, 1_014],
        ],
      );
      assert.deepEqual(
        (await raw.query("SELECT seq, turn_id::text FROM items WHERE turn_id IS NOT NULL ORDER BY seq")).rows,
        [
          { seq: "0", turn_id: runId },
          { seq: "10", turn_id: runId },
        ],
      );

      const tables = await raw.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE '%session_entries'",
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        ["legacy_session_entries"],
      );

      const { lease } = await store.acquireLease(sessionId);
      assert.ok(lease);
      const next = await store.append(lease, { kind: "AgentMessage", text: "first answer after cutover zebracorn" });
      await store.releaseLease(lease);
      assert.equal(next.seq, legacy.length);
      assert.deepEqual(
        (await store.searchEntries("alice", "zebracorn")).map((hit) => [hit.sessionId, hit.seq]),
        [[sessionId, legacy.length]],
        "search write-through now runs on items",
      );
      await raw.query(
        `INSERT INTO legacy_session_entries(session_id, seq, type, payload, scope_label, created_at)
       VALUES ($1, 99, 'user', '{"text":"stale aardwolf"}', $2, 1)`,
        [sessionId, scope],
      );
      assert.deepEqual(await store.searchEntries("alice", "aardwolf"), [], "legacy table no longer feeds search");

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
      await client.end();
      await admin.end();
    }
  },
);
