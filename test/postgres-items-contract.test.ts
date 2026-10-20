import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createLocalDurableByteStore } from "../src/files/durable-byte-store.ts";
import { applyPgMigrations, createPgPool, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import type { NewItem } from "../src/sessions/items.ts";
import { DuplicateCallError } from "../src/sessions/session-store.ts";
import { createPostgresToolOutputStore, DEFAULT_INLINE_TOKENS } from "../src/sessions/tool-output.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the items contract test";

async function withSchema(
  prefix: string,
  fn: (ctx: {
    raw: import("pg").Pool;
    url: string;
    store: ReturnType<typeof createPostgresSessionStore>;
  }) => Promise<void>,
): Promise<void> {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const raw = new pg.Pool({ connectionString: url.toString() });
  try {
    await fn({ raw, url: url.toString(), store: createPostgresSessionStore(url.toString()) });
  } finally {
    await raw.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test("pg items keep turn, author and time in typed columns", { skip }, async () => {
  await withSchema("items_columns", async ({ raw, store }) => {
    const scope = scopeId("personal", "alice");
    const session = await store.getOrCreateByThread("web:columns", "dm", scope);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    const runId = randomUUID();
    const turn = { ...lease, turnId: runId };
    const user = await store.append(turn, { kind: "UserMessage", text: "hi", author: "alice" });
    await store.append(turn, { kind: "SteeringMessage", text: "also", author: "bob" });
    await store.append(turn, { kind: "AgentMessage", text: "hello", author: "ignored-on-agent-items" });
    await store.append({ ...lease, turnId: "not-a-uuid" }, { kind: "ToolCall", tool: "execute", callId: "c1" });
    await store.append(lease, { kind: "Error", errorCode: "turn_failure", text: "x" });
    const stopped = await store.append(turn, { kind: "Stop", author: "alice", body: { reason: "user" } });
    const read = await store.getItem(session.id, stopped.seq);
    assert.equal(read?.turnId, runId);
    assert.deepEqual(read?.body, { reason: "user" });
    await store.releaseLease(lease);

    const rows = (
      await raw.query(
        `SELECT seq::int, kind, turn_id::text, author, error_code, (extract(epoch FROM created_at) * 1000)::bigint AS ms
           FROM items WHERE session_id = $1 ORDER BY seq`,
        [session.id],
      )
    ).rows;
    assert.deepEqual(
      rows.map((row) => [row.seq, row.kind, row.turn_id, row.author, row.error_code]),
      [
        [0, "UserMessage", runId, "alice", null],
        [1, "SteeringMessage", runId, "bob", null],
        [2, "AgentMessage", runId, null, null],
        [3, "ToolCall", null, null, null],
        [4, "Error", null, null, "turn_failure"],
        [5, "Stop", runId, "alice", null],
      ],
    );
    assert.equal(Number(rows[0].ms), user.createdAt);
    assert.equal((await store.getItems(session.id))[0]!.createdAt, user.createdAt);
    await assert.rejects(
      raw.query(
        "INSERT INTO items(tenant_id, session_id, seq, kind, author, body, created_at) VALUES (qm_tenant_id(), $1, 9, 'AgentMessage', 'x', '{}', now())",
        [session.id],
      ),
      /items_author_kind/,
    );
  });
});

test("pg items reject a second call with the same call id, leaving the log untouched", { skip }, async () => {
  await withSchema("items_calls", async ({ store }) => {
    const scope = scopeId("personal", "alice");
    const session = await store.getOrCreateByThread("web:calls", "dm", scope);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    const callId = "cron:1";
    const call: NewItem = { kind: "ToolCall", tool: "deliver", callId, body: { text: "hi" } };
    const result: NewItem = { kind: "ToolResult", tool: "deliver", callId, text: "delivered" };
    await store.appendMany(lease, [call, result]);
    await assert.rejects(store.appendMany(lease, [call, result]), DuplicateCallError);
    const items = await store.getItems(session.id);
    assert.equal(items.length, 2);
    assert.equal(items[0]!.callId, callId);
    const next = await store.append(lease, { kind: "AgentMessage", text: "after" });
    assert.equal(next.seq, 2);
    await store.releaseLease(lease);
  });
});

test(
  "pg tool output: the inline cap comes from qm_settings and parked text reads back by call id",
  { skip },
  async () => {
    await withSchema("items_tool_output", async ({ raw, url, store }) => {
      const dir = await mkdtemp(join(tmpdir(), "tool-output-"));
      const pool = createPgPool(url);
      try {
        const scope = scopeId("personal", "alice");
        const session = await store.getOrCreateByThread("web:tool-output", "dm", scope);
        let clock = Date.now();
        const outputs = createPostgresToolOutputStore({
          pool,
          bytesFor: (prefix) => createLocalDurableByteStore(join(dir, prefix)),
          now: () => clock,
        });
        assert.equal(await outputs.inlineTokens(), DEFAULT_INLINE_TOKENS);
        await raw.query(
          "INSERT INTO qm_settings(key, value) VALUES ('tool_result_inline_tokens', '0') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        );
        assert.equal(await outputs.inlineTokens(), DEFAULT_INLINE_TOKENS, "cached for a short while");
        clock += 60_000;
        assert.equal(await outputs.inlineTokens(), 0);

        const full = "ünï line\n".repeat(10_000);
        const blob = await outputs.save(full);
        const { lease } = await store.acquireLease(session.id);
        assert.ok(lease);
        await store.append(lease, { kind: "ToolCall", tool: "execute", callId: "big" });
        await store.append(lease, {
          kind: "ToolResult",
          tool: "execute",
          callId: "big",
          text: "head…tail",
          blobSha: blob,
          body: { output: { chars: full.length, shownChars: 8 } },
        });
        await store.releaseLease(lease);
        assert.deepEqual(await outputs.read(session.id, "big"), { text: full });
        assert.equal(await outputs.read(session.id, "missing"), null);
        assert.equal(await outputs.read("other-session", "big"), null);
        const row = (
          await raw.query(
            "SELECT size, storage_key, (extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM blobs",
          )
        ).rows[0];
        assert.deepEqual([Number(row.size), row.days], [Buffer.byteLength(full), 30]);
        assert.match(row.storage_key, /^tool-output\/[0-9a-f-]{36}\/files\/[0-9a-f]{64}$/);
      } finally {
        await pool.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);

test(
  "pg items cutover drops legacy participant-activity triggers so participant windows stay exact",
  { skip },
  async () => {
    await withSchema("items_residue", async ({ raw, url, store }) => {
      await applyPgMigrations(
        raw,
        registeredPgMigrations(url).filter((migration) => migration.id < "sessions/store/0029"),
      );
      await raw.query(
        await readFile(
          new globalThis.URL("./fixtures/legacy-participant-activity-triggers.sql", import.meta.url),
          "utf8",
        ),
      );
      const scope = scopeId("personal", "alice");
      const session = await store.getOrCreateByThread("web:residue", "dm", scope);
      const { lease } = await store.acquireLease(session.id);
      assert.ok(lease);
      await store.append(lease, { kind: "UserMessage", text: "one" });
      await store.releaseLease(lease);
      await store.addParticipant(session.id, "bob", undefined, { includeHistory: true });
      await store.addParticipant(session.id, "carol");
      assert.deepEqual(
        (
          await raw.query("SELECT principal_id, valid_from_seq FROM participants WHERE session_id = $1 ORDER BY 1", [
            session.id,
          ])
        ).rows.map((row) => [row.principal_id, row.valid_from_seq]),
        [
          ["bob", 0],
          ["carol", 1],
        ],
      );
    });
  },
);

test("pg items hide a Slack reply receipt once the real message arrives", { skip }, async () => {
  await withSchema("items_receipts", async ({ store }) => {
    const scope = scopeId("personal", "alice");
    const session = await store.getOrCreateByThread("slack:T1:C1:1.0", "dm", scope);
    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    const receipt: NewItem = {
      kind: "UserMessage",
      text: "sent from web",
      externalId: "2.0",
      body: { name: "Alice", slackReplyReceipt: true, deliveryKey: "k-1" },
    };
    await store.appendMany({ ...lease, turnId: randomUUID() }, [receipt]);
    assert.equal(await store.hasDeliveryEntry(session.id, "k-1"), true);
    assert.equal(await store.hasDeliveryEntry(session.id, "k-2", "2.0"), true);
    assert.equal(await store.hasDeliveryEntry(session.id, "k-2", "3.0"), false);
    const texts = async () =>
      (await store.getItems(session.id, { transcript: true })).map((item) => [
        item.text,
        item.body.slackReplyReceipt === true,
      ]);
    assert.deepEqual(await texts(), [["sent from web", true]]);
    await store.append(lease, { kind: "UserMessage", text: "sent from web", externalId: "2.0" });
    assert.deepEqual(await texts(), [["sent from web", false]]);
    assert.equal(await store.countItemsBefore(session.id, 10), 1);
    assert.equal((await store.getItems(session.id)).length, 2);
  });
});
