import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the legacy tape steps test";

async function withSchema(fn: (raw: import("pg").Pool) => Promise<void>): Promise<void> {
  const pg = (await import("pg")).default;
  const admin = new pg.Pool({ connectionString: URL });
  const schema = `tape_steps_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new globalThis.URL(URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const raw = new pg.Pool({ connectionString: url.toString() });
  try {
    createPostgresSessionStore(url.toString());
    createPostgresRunStore(url.toString());
    await applyPgMigrations(raw, registeredPgMigrations(url.toString()));
    await fn(raw);
  } finally {
    await raw.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

const scope = scopeId("personal", "alice");
const message = (content: unknown[]) =>
  `{"role":"assistant","content":${JSON.stringify(content)},"api":"anthropic-messages","provider":"anthropic","model":"claude-opus-5-5","stopReason":"toolUse"}`;

async function seedSession(
  raw: import("pg").Pool,
  id: string,
  tape: string[],
  entries: Array<[string, unknown, number?]>,
) {
  await raw.query("INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ($1, 'dm', $2, $3, 1)", [
    id,
    scope,
    `web:${id}`,
  ]);
  for (const [seq, payload] of tape.entries())
    await raw.query(
      "INSERT INTO session_tape(session_id, seq, kind, harness, payload, scope_label, created_at) VALUES ($1, $2, 'message', 'pi', $3, $4, 1)",
      [id, seq, payload, scope],
    );
  for (const [seq, [type, payload, createdAt]] of entries.entries())
    await raw.query(
      "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1, $2, NULL, $3, $4, $5, $6)",
      [id, seq, type, JSON.stringify(payload), scope, createdAt ?? seq * 100],
    );
}

const addRuns = (raw: import("pg").Pool, rows: Array<[string, string, number | null, number, number | null]>) =>
  Promise.all(
    rows.map(([id, session, turnUserSeq, startedAt, finishedAt]) =>
      raw.query(
        "INSERT INTO runs(id, session_id, status, request, created_at, turn_user_seq, started_at, finished_at) VALUES ($1, $2, 'done', '{}', 1, $3, $4, $5)",
        [id, `web:${session}`, turnUserSeq, startedAt, finishedAt],
      ),
    ),
  );

const progress = async (raw: import("pg").Pool) =>
  (
    await raw.query(
      "SELECT last_session, done, invalid_messages::int, keyed_blocks::int, copied_steps::int, copied_turns::int FROM legacy_tape_steps_progress",
    )
  ).rows[0];

test("pg legacy tape steps keep each step's model and exact block wire, and map turns to runs", { skip }, async () => {
  await withSchema(async (raw) => {
    await seedSession(
      raw,
      "legacy",
      [
        message([
          { type: "thinking", thinking: "plan", thinkingSignature: "sig-1" },
          { type: "text", text: "Checking.", textSignature: "t-sig" },
          { type: "toolCall", id: "c1", name: "execute", arguments: { z: 1, a: { b: 2 } }, thoughtSignature: "ts" },
        ]),
        message([
          { type: "text", text: "Same" },
          { type: "text", text: "Same" },
        ]),
        '{"role":"assistant","content":[{"type":"text","text":"bad \\ud800"}]}',
        message([{ type: "text", text: "Done." }]),
        "null",
        "[]",
      ],
      [
        ["thinking", { thinking: "plan", thinkingSignature: "sig-1" }],
        ["assistant", { text: "Checking." }],
        ["tool_call", { tool: "execute", callId: "c1", a: { b: 2 }, z: 1 }],
        ["assistant", { text: "Same" }],
        ["tool_call", { tool: "execute", callId: "c9", x: 1 }],
        ["user", { text: "first turn" }],
        ["assistant", { text: "first reply" }],
        ["user", { text: "second turn" }],
        ["assistant", { text: "second reply" }],
        ["user", { text: "third turn", runId: "run-c" }],
        ["assistant", { text: "Checking.", step: { id: "s" } }],
        ["user", { text: "during an unfinished run" }],
        ["user", { text: "after the freeze" }, Number.MAX_SAFE_INTEGER],
        ["assistant", { text: "Done." }, 1300],
        ["user", { text: "inside a run that already has its turn" }, 600],
        ["user", { text: "inside a finished run while another is open" }, 1250],
      ],
    );
    await seedSession(raw, "tapeless", [], [["user", { text: "hi" }]]);
    await addRuns(raw, [
      ["run-a", "legacy", 5, 450, 650],
      ["run-b", "legacy", null, 650, 900],
      ["run-open", "legacy", null, 1050, null],
      ["run-late", "legacy", null, 1500, Number.MAX_SAFE_INTEGER],
      ["run-inner", "legacy", null, 1200, 1400],
    ]);
    await raw.query("UPDATE session_tape SET created_at = 10000000 WHERE session_id = 'legacy' AND seq = 3");

    await raw.query("CALL prepare_legacy_tape_steps(1)");

    const step = (index: number) => ({
      id: "tape:0",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-5-5",
      stopReason: "toolUse",
      index,
    });
    assert.deepEqual(
      (await raw.query("SELECT session_id, seq, step, wire FROM legacy_tape_steps ORDER BY session_id, seq")).rows,
      [
        { session_id: "legacy", seq: 0, step: step(0), wire: null },
        { session_id: "legacy", seq: 1, step: step(1), wire: { textSignature: "t-sig" } },
        {
          session_id: "legacy",
          seq: 2,
          step: step(2),
          wire: { argumentsJson: '{"z":1,"a":{"b":2}}', thoughtSignature: "ts" },
        },
      ],
    );
    assert.deepEqual(
      (await raw.query("SELECT session_id, seq, run_id, inferred FROM legacy_turn_runs ORDER BY session_id, seq")).rows,
      [
        { session_id: "legacy", seq: 5, run_id: "run-a", inferred: false },
        { session_id: "legacy", seq: 7, run_id: "run-b", inferred: true },
      ],
    );
    assert.deepEqual(await progress(raw), {
      last_session: "tapeless",
      done: true,
      invalid_messages: 3,
      keyed_blocks: 6,
      copied_steps: 3,
      copied_turns: 2,
    });
    assert.equal((await raw.query("SELECT to_regclass('legacy_prep_runs') AS t")).rows[0].t, null);
    assert.equal((await raw.query("SELECT count(*)::int AS n FROM legacy_tape_writes")).rows[0].n, 0);
  });
});

test(
  "pg legacy tape step preparation resumes from its cursor and records every later tape write",
  { skip },
  async () => {
    await withSchema(async (raw) => {
      for (const id of ["s1", "s2", "s3"])
        await seedSession(
          raw,
          id,
          [message([{ type: "toolCall", id: `call-${id}`, name: "execute", arguments: { id } }])],
          [["tool_call", { tool: "execute", callId: `call-${id}`, id }]],
        );
      await raw.query("CALL prepare_legacy_tape_steps(1)");
      await raw.query("UPDATE legacy_tape_steps_progress SET last_session = 's1', done = false");
      await raw.query("DELETE FROM legacy_tape_steps WHERE session_id <> 's1'");

      await raw.query("CALL prepare_legacy_tape_steps(1)");

      assert.deepEqual(
        (await raw.query("SELECT session_id FROM legacy_tape_steps ORDER BY session_id")).rows.map((r) => r.session_id),
        ["s1", "s2", "s3"],
      );
      await raw.query("DELETE FROM session_tape WHERE session_id = 'none'");
      const client = await raw.connect();
      try {
        await client.query("SET session_replication_role = replica");
        await client.query("UPDATE session_tape SET harness = 'pi' WHERE session_id = 's1'");
      } finally {
        await client.query("RESET session_replication_role");
        client.release();
      }
      assert.equal((await raw.query("SELECT count(*)::int AS n FROM legacy_tape_writes")).rows[0].n, 2);

      await raw.query("DROP TRIGGER legacy_tape_frozen ON session_tape");
      await assert.rejects(raw.query("CALL prepare_legacy_tape_steps(1)"), /a preparation already started/);
    });
  },
);

test("pg legacy tape step preparation skips payloads too large to parse and counts them", { skip }, async () => {
  await withSchema(async (raw) => {
    const huge = message([{ type: "text", text: "x".repeat(64 * 1024 * 1024) }]);
    await seedSession(
      raw,
      "huge",
      [huge, message([{ type: "toolCall", id: "call-ok", name: "execute", arguments: {} }])],
      [
        ["tool_call", { tool: "execute", callId: "call-ok" }],
        ["user", { text: "y".repeat(64 * 1024 * 1024) }],
      ],
    );

    await raw.query("CALL prepare_legacy_tape_steps(1)");

    assert.deepEqual((await raw.query("SELECT session_id, seq FROM legacy_tape_steps ORDER BY seq")).rows, [
      { session_id: "huge", seq: 0 },
    ]);
    assert.deepEqual(await progress(raw), {
      last_session: "huge",
      done: true,
      invalid_messages: 1,
      keyed_blocks: 1,
      copied_steps: 1,
      copied_turns: 0,
    });
  });
});
