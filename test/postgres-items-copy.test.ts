import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { itemsCopySql, itemsCopySelectedSql, itemsSelectedRowsSql } from "../src/sessions/items-copy.ts";
import { ITEM_INDEXES } from "../src/sessions/items-schema.ts";
import { scopeId } from "../src/types.ts";

type Pool = import("pg").Pool;

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the items copy test";
const T0 = 1_700_000_000_000;

const ITEMS_MIGRATION = "sessions/store/0035-items";

async function withSchema(
  fn: (raw: Pool, url: string) => Promise<void>,
  opts: { beforeItems?: (raw: Pool) => Promise<void> } = {},
): Promise<void> {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  const schema = `items_copy_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const raw = new pg.Pool({ connectionString: url.toString() });
  try {
    createPostgresSessionStore(url.toString());
    createPostgresDirectoryStore(url.toString());
    const migrations = registeredPgMigrations(url.toString());
    if (opts.beforeItems) {
      await applyPgMigrations(
        raw,
        migrations.filter((migration) => migration.id !== ITEMS_MIGRATION),
      );
      await opts.beforeItems(raw);
    }
    await applyPgMigrations(raw, migrations);
    await fn(raw, url.toString());
  } finally {
    await raw.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

const scope = scopeId("personal", "alice");

async function seed(raw: Pool, id: string, entries: Array<[string, unknown]>, from = 0) {
  await raw.query(
    "INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ($1, 'dm', $2, $3, 1) ON CONFLICT DO NOTHING",
    [id, scope, `web:${id}`],
  );
  for (const [i, [type, payload]] of entries.entries())
    await raw.query(
      "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1, $2, NULL, $3, $4, $5, $6)",
      [id, from + i, type, JSON.stringify(payload), scope, T0 + from + i],
    );
}

async function copyAll(raw: Pool, buckets = 4, delta = false): Promise<number> {
  let total = 0;
  for (let index = 0; index < buckets; index++)
    total += (await raw.query(itemsCopySql({ delta, bucket: { index, count: buckets } }))).rows[0].rows;
  return total;
}

const items = async (raw: Pool, sessionId: string) =>
  (
    await raw.query(
      `SELECT seq::int, turn_id, kind, author, call_id, elicit_id, wake_cause, error_code, text, tool, step,
              variant, is_error, hidden, external_id, through_seq::int, target_seq::int, approved, body,
              (extract(epoch FROM created_at) * 1000)::bigint::text AS ms
         FROM items WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    )
  ).rows as Array<Record<string, unknown> & { seq: number; body: Record<string, unknown> }>;

test("items copy maps every legacy type, hoists fields into columns and strips them from body", { skip }, async () => {
  await withSchema(async (raw) => {
    const run = randomUUID();
    await seed(raw, "s1", [
      ["soul", { text: "persona" }],
      ["user", { text: "hi", runId: run, securityTainted: true, ts: "1.1", hidden: true, name: "Al" }],
      ["user", { text: "also", steered: true, ts: "1.5" }],
      ["text_start", {}],
      ["text", { text: "narrating" }],
      ["thinking", { thinking: "hmm", thinkingSignature: "sig" }],
      ["tool_call", { tool: "execute", callId: "c1", args: { cmd: "ls" } }],
      [
        "tool_result",
        {
          tool: "execute",
          callId: "c1",
          result: "out: hello\nerr: boom",
          stdout: "hello",
          stderr: "nope",
          isError: true,
        },
      ],
      ["tool_call", { tool: "execute" }],
      ["assistant", { text: "done", deliveryKey: "k1", runId: "not-a-uuid", via: "cron" }],
      ["delivery", { files: ["a.txt"] }],
      ["approval_request", { requestId: "r1", command: "rm" }],
      ["approval_resolved", { approved: true }],
      ["system", { kind: "context_summary", text: "summary", throughSeq: 3 }],
      ["system", { kind: "turn_failure", message: "failed", deliveryKey: "k2", runId: run }],
      ["system", { kind: "wake", text: "follow-up" }],
      ["system", { kind: "wake", cause: "cron", text: "fire" }],
      ["system", { kind: "message_revision", action: "deleted", ts: "1.1" }],
      ["system", { kind: "goal", goal: {} }],
      ["system", { kind: "memory_context", snapshot: {} }],
      ["system", { kind: "file_event", direction: "in" }],
      ["user", "just a string"],
      ["user", { type: "x", $type: "y", $blobs: [], text: "t" }],
      ["assistant", 5],
      ["tool_result", { callId: "", result: { ok: true }, stdout: "kept" }],
      ["user", { text: "" }],
    ]);
    await raw.query(
      `INSERT INTO legacy_tape_steps(session_id, seq, step, wire)
       VALUES ('s1', 6, '{"id":"tape:1","model":"m","index":2}', '{"x":1}'), ('s1', 5, '{"id":"tape:1","index":0}', NULL)`,
    );

    assert.equal(await copyAll(raw), 21);
    const rows = await items(raw, "s1");
    const at = (seq: number) => rows.find((row) => row.seq === seq)!;
    assert.deepEqual(
      rows.map((row) => [row.seq, row.kind]),
      [
        [1, "UserMessage"],
        [2, "SteeringMessage"],
        [4, "AgentMessage"],
        [5, "Reasoning"],
        [6, "ToolCall"],
        [7, "ToolResult"],
        [8, "ToolCall"],
        [9, "AgentMessage"],
        [10, "AgentMessage"],
        [11, "Elicitation"],
        [12, "ElicitationResponse"],
        [13, "ContextCompaction"],
        [14, "Error"],
        [15, "Wake"],
        [16, "Wake"],
        [17, "Retraction"],
        [21, "UserMessage"],
        [22, "UserMessage"],
        [23, "AgentMessage"],
        [24, "ToolResult"],
        [25, "UserMessage"],
      ],
    );
    assert.equal(at(1).ms, String(T0 + 1));
    assert.deepEqual(
      [at(1).turn_id, at(1).text, at(1).hidden, at(1).external_id, at(1).body],
      [run, "hi", true, "1.1", { name: "Al" }],
    );
    assert.deepEqual([at(2).text, at(2).external_id, at(2).body], ["also", null, { ts: "1.5" }]);
    assert.deepEqual([at(4).text, at(4).variant, at(4).body], ["narrating", "narration", {}]);
    assert.deepEqual(
      [at(5).text, at(5).step, at(5).body],
      ["hmm", 0, { thinkingSignature: "sig", wire: { message: { id: "tape:1" } } }],
    );
    assert.deepEqual(
      [at(6).call_id, at(6).tool, at(6).step, at(6).body],
      ["c1", "execute", 2, { args: { cmd: "ls" }, wire: { x: 1, message: { id: "tape:1", model: "m" } } }],
    );
    assert.deepEqual(
      [at(7).call_id, at(7).tool, at(7).text, at(7).is_error, at(7).body],
      ["c1", "execute", "out: hello\nerr: boom", true, { stderr: "nope" }],
    );
    assert.equal(at(8).call_id, null);
    assert.deepEqual(
      [at(9).turn_id, at(9).text, at(9).variant, at(9).body],
      [null, "done", null, { runId: "not-a-uuid", via: "cron" }],
    );
    assert.deepEqual([at(10).variant, at(10).text, at(10).body], ["files_delivered", null, { files: ["a.txt"] }]);
    assert.deepEqual([at(11).elicit_id, at(11).body], ["r1", { command: "rm" }]);
    assert.deepEqual([at(12).elicit_id, at(12).approved, at(12).body], ["missing-elicit:12", true, {}]);
    assert.deepEqual([at(13).text, at(13).through_seq, at(13).body], ["summary", 3, {}]);
    assert.deepEqual(
      [at(14).error_code, at(14).text, at(14).turn_id, at(14).body],
      ["turn_failure", "failed", run, {}],
    );
    assert.deepEqual([at(15).wake_cause, at(15).body], ["system", { text: "follow-up" }]);
    assert.deepEqual([at(16).wake_cause, at(16).body], ["cron", { text: "fire" }]);
    assert.deepEqual([at(17).target_seq, at(17).body], [1, { action: "deleted", ts: "1.1" }]);
    assert.deepEqual([at(21).text, at(21).body], ["just a string", {}]);
    assert.deepEqual([at(22).text, at(22).body], ["t", { type: "x", $type: "y", $blobs: [] }]);
    assert.deepEqual(at(23).body, { value: 5 });
    assert.deepEqual(
      [at(24).call_id, at(24).text, at(24).body],
      [null, null, { result: { ok: true }, stdout: "kept" }],
    );
    assert.deepEqual([at(25).text, at(25).body], [null, {}]);
  });
});

test("items copy deduces legacy authors from participants and directory names", { skip }, async () => {
  await withSchema(async (raw) => {
    const join = (session: string, principal: string, from: number, to: number | null) =>
      raw.query("INSERT INTO participants(session_id, principal_id, valid_from, valid_to) VALUES ($1, $2, $3, $4)", [
        session,
        principal,
        from,
        to,
      ]);
    await raw.query(
      `INSERT INTO directory_members(org_id, principal_id, display_name, display_name_lc, type)
       VALUES ('o', 'u:ann', 'Ann Lee', 'ann lee', 'internal'), ('o', 'u:bob', 'Bob', 'bob', 'internal')`,
    );
    await seed(raw, "solo", [
      ["user", { text: "before ann joined" }],
      ["user", { text: "ann alone" }],
      ["user", { text: "both here", name: "bob" }],
      ["user", { text: "both here, nameless" }],
      ["user", { text: "overheard", overheard: true, ts: "9.1", name: "Ann Lee" }],
      ["user", { text: "agent echo", overheard: true, ts: "9.2", sourceRole: "agent", name: "Ann Lee" }],
      ["approval_resolved", { requestId: "r", approved: false }],
    ]);
    await join("solo", "u:ann", T0 + 1, null);
    await join("solo", "u:bob", T0 + 2, T0 + 6);
    const counts = (await raw.query(itemsCopySql())).rows[0];
    assert.deepEqual(counts, { rows: 7, author_eligible: 7, author_null: 3 });
    assert.deepEqual(
      (await items(raw, "solo")).map((row) => [row.seq, row.author]),
      [
        [0, null],
        [1, "u:ann"],
        [2, "u:bob"],
        [3, null],
        [4, "u:ann"],
        [5, null],
        [6, "u:ann"],
      ],
    );
  });
});

test("items CHECKs tie each hoisted column to its kinds and search indexes the text", { skip }, async () => {
  await withSchema(async (raw) => {
    await seed(raw, "c", []);
    const insert = (cols: string, values: string) =>
      raw.query(
        `INSERT INTO items(tenant_id, session_id, seq, body, created_at, ${cols})
         SELECT id, 'c', (SELECT count(*) FROM items), '{}', now(), ${values} FROM qm_tenant`,
      );
    await insert("kind, text", "'UserMessage', 'the quick brown fox'");
    await insert("kind, call_id, tool, is_error", "'ToolResult', 'c1', 'execute', false");
    for (const [cols, values, constraint] of [
      ["kind, tool", "'UserMessage', 'execute'", /items_tool_kind/],
      ["kind, variant", "'AgentMessage', 'reply'", /variant_check/],
      ["kind, text", "'UserMessage', ''", /text_check/],
      ["kind, hidden", "'SteeringMessage', true", /items_hidden_kind/],
      ["kind, external_id", "'AgentMessage', '1.1'", /items_external_id_kind/],
      ["kind, through_seq", "'Retraction', 1", /items_through_seq_kind/],
      ["kind, target_seq", "'ContextCompaction', 1", /items_target_seq_kind/],
      ["kind, approved", "'Elicitation', true", /items_approved_kind/],
      ["kind, author", "'AgentMessage', 'u:ann'", /items_author_kind/],
      ["kind, call_id, blob_sha", "'ToolResult', 'c2', sha256('x')", /items_blob/],
    ] as const)
      await assert.rejects(insert(cols, values), constraint);
    await insert("kind, author", "'Stop', 'u:ann'");
    await insert("kind, author", "'RuntimeChange', 'u:ann'");
    const hits = await raw.query(
      "SELECT seq::int FROM items WHERE session_id = 'c' AND search @@ to_tsquery('simple', 'brown & fox')",
    );
    assert.deepEqual(hits.rows, [{ seq: 0 }]);
  });
});

test("items copy fails loudly on an unmapped entry type or system kind", { skip }, async () => {
  await withSchema(async (raw) => {
    await seed(raw, "ok", [["user", { text: "fine" }]]);
    await seed(raw, "bad", [["system", { kind: "mystery" }]]);
    await assert.rejects(copyAll(raw, 1), /unmapped system entry kind=mystery at bad\/0/);
    await raw.query("DELETE FROM session_entries WHERE session_id = 'bad'");
    await seed(raw, "bad2", [["weird", { text: "?" }]]);
    await assert.rejects(copyAll(raw, 1), /unmapped entry type=weird at bad2\/0/);
    assert.equal((await raw.query("SELECT count(*)::int AS n FROM items")).rows[0].n, 0);
  });
});

test("bucketed bulk copy partitions sessions and delta copies only new entries", { skip }, async () => {
  await withSchema(async (raw) => {
    for (let i = 0; i < 12; i++)
      await seed(raw, `s${i}`, [
        ["user", { text: `q${i}` }],
        ["assistant", { text: `a${i}` }],
      ]);
    assert.equal(await copyAll(raw), 24);
    assert.equal(await copyAll(raw, 4, true), 0);
    await seed(
      raw,
      "s3",
      [
        ["user", { text: "later" }],
        ["system", { kind: "goal" }],
        ["thinking", { thinking: "x" }],
      ],
      2,
    );
    await seed(raw, "fresh", [["user", { text: "new session" }]]);
    assert.equal(await copyAll(raw, 1, true), 3);
    assert.deepEqual(
      (await items(raw, "s3")).map((row) => [row.seq, row.kind]),
      [
        [0, "UserMessage"],
        [1, "AgentMessage"],
        [2, "UserMessage"],
        [4, "Reasoning"],
      ],
    );
    assert.equal(await copyAll(raw, 1, true), 0);
    assert.throws(() => itemsCopySql({ bucket: { index: 4, count: 4 } }), /bucket 4 of 4 is invalid/);
  });
});

test("the startup migration copies existing history and builds the indexes", { skip }, async () => {
  await withSchema(
    async (raw) => {
      assert.deepEqual(
        (await items(raw, "old")).map((row) => [row.seq, row.kind, row.text]),
        [
          [0, "UserMessage", "before items existed"],
          [1, "ToolCall", null],
        ],
      );
      const built = await raw.query(
        `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE i.indrelid = 'items'::regclass AND i.indisvalid AND c.relname = ANY($1)`,
        [ITEM_INDEXES.map((index) => index.name)],
      );
      assert.equal(built.rowCount, ITEM_INDEXES.length);
    },
    {
      beforeItems: (raw) =>
        seed(raw, "old", [
          ["user", { text: "before items existed" }],
          ["tool_call", { tool: "deliver", callId: "c1" }],
        ]),
    },
  );
});

test(
  "items copy repairs unsupported JSON escapes, preserves literals and rejects other broken payloads",
  { skip },
  async () => {
    await withSchema(async (raw) => {
      await seed(raw, "repair", []);
      const payloads = [
        String.raw`{"text":"nul\u0000end"}`,
        String.raw`{"text":"high\ud800end"}`,
        String.raw`{"text":"low\udc00end"}`,
        String.raw`{"text":"pair\ud83d\ude00"}`,
        String.raw`{"text":"literal\\u0000"}`,
        null,
        "7",
        "true",
      ];
      for (const [seq, payload] of payloads.entries())
        await raw.query(
          "INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at) VALUES('repair',$1,'user',$2,'personal:test',1)",
          [seq, payload],
        );
      assert.equal(await copyAll(raw, 1), 8);
      const result = await items(raw, "repair");
      assert.deepEqual(
        result.slice(0, 5).map((r) => r.text),
        ["nulend", "high�end", "low�end", "pair😀", String.raw`literal\u0000`],
      );
      assert.deepEqual(
        result.slice(5).map((r) => r.body),
        [{}, { value: 7 }, { value: true }],
      );
      await raw.query("UPDATE session_entries SET payload='not json' WHERE seq=0");
      await raw.query("DELETE FROM items");
      await assert.rejects(copyAll(raw, 1), /invalid input syntax/);
      assert.equal((await raw.query("SELECT count(*)::int AS n FROM items")).rows[0].n, 0);
    });
  },
);

test("selected-key copying uses the same mapping on TEXT and JSONB without copying other rows", { skip }, async () => {
  await withSchema(async (raw) => {
    await seed(raw, "selected", [
      ["user", { text: "one" }],
      ["assistant", { text: "two" }],
      ["soul", {}],
    ]);
    const client = await raw.connect();
    try {
      await client.query("CREATE TEMP TABLE items_copy_batch(session_id text,seq int,PRIMARY KEY(session_id,seq))");
      await client.query("INSERT INTO items_copy_batch VALUES('selected',1),('selected',2)");
      assert.equal((await client.query(itemsCopySelectedSql())).rows[0].rows, 1);
      assert.deepEqual(
        (await items(raw, "selected")).map((r) => r.text),
        ["two"],
      );
      const expected = (await client.query(itemsSelectedRowsSql())).rows[0];
      assert.equal(expected.kind, "AgentMessage");
      assert.equal(expected.text, "two");
      await client.query(
        "CREATE TEMP TABLE source_rows AS SELECT session_id,seq,type,payload,created_at FROM session_entries",
      );
      await client.query("CREATE TEMP TABLE session_entries AS SELECT * FROM source_rows WITH NO DATA");
      await client.query("ALTER TABLE pg_temp.session_entries ALTER COLUMN payload TYPE jsonb USING payload::jsonb");
      await client.query(
        "INSERT INTO pg_temp.session_entries SELECT session_id,seq,type,payload::jsonb,created_at FROM source_rows",
      );
      await client.query("DELETE FROM items");
      assert.equal((await client.query(itemsCopySelectedSql())).rows[0].rows, 1);
      assert.equal((await client.query(itemsSelectedRowsSql())).rows[0].text, "two");
    } finally {
      client.release();
    }
  });
});

test("items copy preserves missing call IDs as NULL and still constrains present IDs", { skip }, async () => {
  await withSchema(async (raw) => {
    await seed(raw, "nullable-calls", [
      ["tool_call", { tool: "execute", command: "echo hello" }],
      ["tool_result", { tool: "execute", result: "hello" }],
      ["tool_call", { tool: "execute", callId: "" }],
      ["tool_result", { tool: "execute", callId: null }],
      ["tool_call", { tool: "execute", callId: "real-call" }],
      ["tool_result", { tool: "execute", callId: "real-call" }],
    ]);
    await copyAll(raw, 1);
    const rows = await items(raw, "nullable-calls");
    assert.deepEqual(
      rows.map((row) => row.call_id),
      [null, null, null, null, "real-call", "real-call"],
    );
    assert.ok(rows.every((row) => !("callId" in row.body)));
    await assert.rejects(
      raw.query("UPDATE items SET call_id='' WHERE session_id='nullable-calls' AND seq=0"),
      /check constraint/,
    );
    await assert.rejects(
      raw.query("UPDATE items SET call_id='real-call' WHERE session_id='nullable-calls' AND seq=0"),
      /unique constraint/,
    );
    await assert.rejects(
      raw.query("UPDATE items SET kind='UserMessage',tool=NULL WHERE session_id='nullable-calls' AND seq=4"),
      /items_call_id_kind/,
    );
  });
});

test("payload parsing keeps ordinary JSON fast-path and Unicode repair semantics", { skip }, async () => {
  await withSchema(async (raw) => {
    const valid: Array<[string, unknown]> = [
      [
        String.raw`{"text":"ordinary \"quoted\" text","values":[1,true,null]}`,
        { text: 'ordinary "quoted" text', values: [1, true, null] },
      ],
      [String.raw`{"text":"\u0041"}`, { text: "A" }],
      [String.raw`{"text":"before\u0000after"}`, { text: "beforeafter" }],
      [String.raw`{"text":"before\ud800after"}`, { text: "before�after" }],
      [String.raw`{"text":"literal\\u0000"}`, { text: String.raw`literal\u0000` }],
    ];
    for (const [input, expected] of valid)
      assert.deepEqual(
        (await raw.query("SELECT items_copy_payload($1::text) AS parsed", [input])).rows[0].parsed,
        expected,
      );
    for (const input of [String.raw`{"text":"\q"}`, '{"text":"unfinished"', String.raw`{"text":"\u0000","bad":}`])
      await assert.rejects(raw.query("SELECT items_copy_payload($1::text)", [input]), /invalid input syntax/);
  });
});

test("items copy preserves stopped-turn records", { skip }, async () => {
  await withSchema(async (raw) => {
    const runId = "11111111-1111-4111-8111-111111111111";
    await seed(raw, "stopped", [["system", { kind: "turn_stopped", runId, reason: "user", text: "Stopped" }]]);
    await raw.query("INSERT INTO participants(session_id, principal_id, valid_from) VALUES ('stopped', 'u:ann', 0)");
    await raw.query(itemsCopySql());
    const [row] = await items(raw, "stopped");
    assert.ok(row);
    assert.equal(row.kind, "Stop");
    assert.equal(row.turn_id, runId);
    assert.equal(row.author, "u:ann");
    assert.deepEqual(row.body, { reason: "user", text: "Stopped" });
  });
});

test("items copy maps goal cancellation notices to system wakes", { skip }, async () => {
  await withSchema(async (raw) => {
    const body = { kind: "goal_cancelled", objective: "A sample goal", cancelledBy: "u:ann" };
    await seed(raw, "cancelled-goal", [["system", body]]);
    await raw.query(itemsCopySql());
    const [row] = await items(raw, "cancelled-goal");
    assert.ok(row);
    assert.equal(row.kind, "Wake");
    assert.equal(row.wake_cause, "system");
    assert.equal(row.author, null);
    assert.deepEqual(row.body, body);
    await raw.query("CREATE TEMP TABLE items_copy_batch(session_id text,seq int,PRIMARY KEY(session_id,seq))");
    await raw.query("INSERT INTO items_copy_batch VALUES ('cancelled-goal', 0)");
    const selected = (await raw.query(itemsSelectedRowsSql())).rows[0];
    assert.equal(selected.kind, "Wake");
    assert.equal(selected.wake_cause, "system");
    assert.deepEqual(selected.body, body);
  });
});

test("oversized legacy call identifiers become NULL without dropping history", { skip }, async () => {
  await withSchema(async (raw) => {
    const callId = "x".repeat(1025);
    const boundary = "x".repeat(1024);
    await seed(raw, "long-calls", [
      ["tool_call", { tool: "execute", callId, command: "echo preserved" }],
      ["tool_result", { tool: "execute", callId, result: "preserved output" }],
      ["tool_call", { tool: "execute", callId: boundary }],
      ["tool_result", { tool: "execute", callId: boundary, result: "boundary output" }],
      ["tool_call", { tool: "execute", callId: "é".repeat(513) }],
    ]);
    await raw.query(itemsCopySql());
    const rows = await items(raw, "long-calls");
    assert.deepEqual(
      rows.map((row) => row.call_id),
      [null, null, boundary, boundary, null],
    );
    assert.equal(rows[0]!.body.command, "echo preserved");
    assert.equal(rows[1]!.text, "preserved output");
    assert.equal(rows[3]!.text, "boundary output");
    await raw.query("CREATE TEMP TABLE items_copy_batch(session_id text,seq int,PRIMARY KEY(session_id,seq))");
    await raw.query("INSERT INTO items_copy_batch SELECT session_id,seq FROM session_entries");
    const selected = (await raw.query(itemsSelectedRowsSql())).rows;
    assert.deepEqual(
      selected.map((row) => row.call_id),
      [null, null, boundary, boundary, null],
    );
  });
});

test("ambiguous legacy IDs are cleared across calls and results, including across batches", { skip }, async () => {
  await withSchema(async (raw) => {
    await seed(raw, "ambiguous", [
      ["tool_call", { tool: "execute", callId: "repeated-result", command: "preserved" }],
      ["tool_result", { tool: "execute", callId: "repeated-result", result: "first" }],
      ["tool_result", { tool: "execute", callId: "repeated-result", result: "second" }],
      ["tool_call", { tool: "execute", callId: "repeated-call" }],
      ["tool_call", { tool: "execute", callId: "repeated-call" }],
      ["tool_result", { tool: "execute", callId: "repeated-call", result: "third" }],
      ["tool_call", { tool: "execute", callId: "valid-pair" }],
      ["tool_result", { tool: "execute", callId: "valid-pair", result: "valid" }],
    ]);
    await seed(raw, "other-session", [["tool_call", { tool: "execute", callId: "repeated-call" }]]);
    await raw.query("CREATE TEMP TABLE items_copy_batch(session_id text,seq int,PRIMARY KEY(session_id,seq))");
    await raw.query("INSERT INTO items_copy_batch VALUES ('ambiguous',0),('ambiguous',1)");
    await raw.query(itemsCopySelectedSql());
    assert.deepEqual(
      (await items(raw, "ambiguous")).map((row) => row.call_id),
      [null, null],
    );
    await raw.query("TRUNCATE items");
    await raw.query(itemsCopySql());
    const rows = await items(raw, "ambiguous");
    assert.deepEqual(
      rows.map((row) => row.call_id),
      [null, null, null, null, null, null, "valid-pair", "valid-pair"],
    );
    assert.equal(rows[0]!.body.command, "preserved");
    assert.deepEqual([rows[1]!.text, rows[2]!.text, rows[5]!.text], ["first", "second", "third"]);
    assert.equal((await items(raw, "other-session"))[0]!.call_id, "repeated-call");
  });
});
