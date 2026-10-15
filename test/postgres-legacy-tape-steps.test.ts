import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the legacy tape steps test";

const beforeTapeDrop = (id: string) => !id.startsWith("sessions/store/") || id < "sessions/store/0031";

async function withSchema(fn: (raw: import("pg").Pool, url: string) => Promise<void>): Promise<void> {
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
    await applyPgMigrations(
      raw,
      registeredPgMigrations(url.toString()).filter((migration) => beforeTapeDrop(migration.id)),
    );
    await fn(raw, url.toString());
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

const toolCallSession = (raw: import("pg").Pool, id: string) =>
  seedSession(
    raw,
    id,
    [message([{ type: "toolCall", id: `call-${id}`, name: "execute", arguments: { z: id, a: 1 } }])],
    [["tool_call", { tool: "execute", callId: `call-${id}`, a: 1, z: id }]],
  );

const tapeState = async (raw: import("pg").Pool) => ({
  tape: (await raw.query("SELECT to_regclass('session_tape') AS t")).rows[0].t,
  steps: (await raw.query("SELECT session_id, wire FROM legacy_tape_steps ORDER BY session_id")).rows,
  done: (await raw.query("SELECT done FROM legacy_tape_steps_progress")).rows[0].done,
});

test(
  "pg migrations copy legacy tape steps on their own before dropping the tape, past deleted sessions",
  { skip },
  async () => {
    await withSchema(async (raw, url) => {
      await toolCallSession(raw, "legacy");
      await toolCallSession(raw, "zdeleted");
      await raw.query("DELETE FROM sessions WHERE id = 'zdeleted'");
      await seedSession(raw, "tapeless", [], [["user", { text: "hi" }]]);
      const pg = (await import("pg")).default;
      const timed = new globalThis.URL(url);
      timed.searchParams.set("options", `${timed.searchParams.get("options")} -c statement_timeout=4321`);
      const startup = new pg.Pool({ connectionString: timed.toString(), max: 1 });
      try {
        await applyPgMigrations(startup, registeredPgMigrations(url));
        assert.equal((await startup.query("SHOW statement_timeout")).rows[0].statement_timeout, "4321ms");
      } finally {
        await startup.end();
      }
      assert.deepEqual(await tapeState(raw), {
        tape: null,
        steps: [{ session_id: "legacy", wire: { argumentsJson: '{"z":"legacy","a":1}' } }],
        done: true,
      });
    });
  },
);

test("pg migrations drop a tape whose sessions were all deleted", { skip }, async () => {
  await withSchema(async (raw, url) => {
    await toolCallSession(raw, "gone");
    await raw.query("DELETE FROM sessions");
    await applyPgMigrations(raw, registeredPgMigrations(url));
    assert.deepEqual(await tapeState(raw), { tape: null, steps: [], done: false });
  });
});

test("pg migrations resume an interrupted tape copy once when two instances start together", { skip }, async () => {
  await withSchema(async (raw, url) => {
    for (const id of ["s1", "s2", "s3"]) await toolCallSession(raw, id);
    await raw.query("CALL prepare_legacy_tape_steps(1)");
    await raw.query("UPDATE legacy_tape_steps_progress SET last_session = 's1', done = false");
    await raw.query("DELETE FROM legacy_tape_steps WHERE session_id <> 's1'");

    const pg = (await import("pg")).default;
    const other = new pg.Pool({ connectionString: url });
    try {
      await Promise.all([
        applyPgMigrations(raw, registeredPgMigrations(url)),
        applyPgMigrations(other, registeredPgMigrations(url)),
      ]);
    } finally {
      await other.end();
    }
    assert.deepEqual(await tapeState(raw), {
      tape: null,
      steps: ["s1", "s2", "s3"].map((id) => ({
        session_id: id,
        wire: { argumentsJson: `{"z":"${id}","a":1}` },
      })),
      done: true,
    });
  });
});

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

test(
  "pg migrations drop the tape only after a completed preparation that saw no later tape write",
  { skip },
  async () => {
    await withSchema(async (raw, url) => {
      await seedSession(
        raw,
        "legacy",
        [message([{ type: "toolCall", id: "c1", name: "execute", arguments: { b: 1, a: 2 } }])],
        [["tool_call", { tool: "execute", callId: "c1", a: 2, b: 1 }]],
      );
      const migrations = registeredPgMigrations(url);
      await raw.query("CALL prepare_legacy_tape_steps()");
      await raw.query("UPDATE legacy_tape_steps_progress SET skipped_sessions = 101");
      await assert.rejects(
        applyPgMigrations(raw, migrations),
        /101 sessions were skipped during the preparation, more than 100/,
      );
      await raw.query("UPDATE legacy_tape_steps_progress SET skipped_sessions = 0, last_session = 'a'");
      await assert.rejects(
        applyPgMigrations(raw, migrations),
        /marked done but its cursor a is before the last tape session legacy/,
      );
      await raw.query("UPDATE legacy_tape_steps_progress SET last_session = 'legacy'");
      await raw.query("UPDATE session_tape SET harness = 'pi'");
      await assert.rejects(
        applyPgMigrations(raw, migrations),
        /written 1 times after prepare_legacy_tape_steps\(\) started, first at \d+/,
      );

      await raw.query("DELETE FROM legacy_tape_writes");
      await raw.query("ALTER TABLE session_tape ENABLE TRIGGER legacy_tape_frozen");
      await assert.rejects(applyPgMigrations(raw, migrations), /missing or not always enabled/);

      await raw.query("ALTER TABLE session_tape ENABLE ALWAYS TRIGGER legacy_tape_frozen");
      await applyPgMigrations(raw, migrations);
      assert.deepEqual(
        (
          await raw.query(
            `SELECT to_regclass('session_tape') AS tape, to_regclass('session_transcript_entries') AS view,
                  to_regclass('legacy_tape_writes') AS writes,
                  to_regprocedure('prepare_legacy_tape_steps(int)') AS prepare, to_regprocedure('legacy_tape_written()') AS written,
                  to_regprocedure('legacy_tape_steps_batch(text[], bigint)') AS batch, to_regclass('legacy_tape_skipped') IS NOT NULL AS skipped`,
          )
        ).rows[0],
        { tape: null, view: null, writes: null, prepare: null, written: null, batch: null, skipped: true },
      );
      assert.deepEqual((await raw.query("SELECT seq, wire FROM legacy_tape_steps")).rows, [
        { seq: 0, wire: { argumentsJson: '{"b":1,"a":2}' } },
      ]);
      assert.equal((await raw.query("SELECT copied_steps::int AS n FROM legacy_tape_steps_progress")).rows[0].n, 1);
    });
  },
);

test("pg legacy tape step preparation skips oversized payloads and sessions it cannot parse", { skip }, async () => {
  await withSchema(async (raw) => {
    await seedSession(
      raw,
      "huge",
      [message([{ type: "toolCall", id: "call-huge", name: "execute", arguments: {} }])],
      [["tool_call", { tool: "execute", callId: "call-huge" }]],
    );
    await raw.query(
      `INSERT INTO session_tape(session_id, seq, kind, harness, payload, scope_label, created_at)
       VALUES ('huge', 1, 'message', 'pi', '{"role":"assistant","content":[{"type":"text","text":"' || repeat('x', 16 * 1024 * 1024) || '"}]}', $1, 1)`,
      [scope],
    );
    await seedSession(
      raw,
      "nested",
      [message([{ type: "toolCall", id: "call-nested", name: "execute", arguments: {} }])],
      [["tool_call", { tool: "execute", callId: "call-nested" }]],
    );
    await raw.query(
      `INSERT INTO session_tape(session_id, seq, kind, harness, payload, scope_label, created_at)
       VALUES ('nested', 1, 'message', 'pi', '{"role":"assistant","content":' || repeat('[', 200000) || repeat(']', 200000) || '}', $1, 1)`,
      [scope],
    );
    await seedSession(
      raw,
      "plain",
      [message([{ type: "toolCall", id: "call-plain", name: "execute", arguments: {} }])],
      [["tool_call", { tool: "execute", callId: "call-plain" }]],
    );

    await raw.query("CALL prepare_legacy_tape_steps(50)");

    assert.deepEqual(
      (await raw.query("SELECT session_id FROM legacy_tape_steps ORDER BY session_id")).rows.map((r) => r.session_id),
      ["huge", "plain"],
    );
    const skipped = (await raw.query("SELECT session_id, error FROM legacy_tape_skipped")).rows;
    assert.deepEqual(
      skipped.map((r) => r.session_id),
      ["nested"],
    );
    assert.match(skipped[0].error, /^54001: stack depth limit exceeded/);
    assert.deepEqual(
      {
        ...(await progress(raw)),
        skipped: (await raw.query("SELECT skipped_sessions::int AS n FROM legacy_tape_steps_progress")).rows[0].n,
      },
      {
        last_session: "plain",
        done: true,
        invalid_messages: 1,
        keyed_blocks: 2,
        copied_steps: 2,
        copied_turns: 0,
        skipped: 1,
      },
    );
  });
});

test(
  "pg legacy tape step preparation stops instead of skipping when every session in a batch fails",
  { skip },
  async () => {
    await withSchema(async (raw) => {
      for (const id of ["a", "b"])
        await seedSession(
          raw,
          id,
          [message([{ type: "toolCall", id: `call-${id}`, name: "execute", arguments: {} }])],
          [["tool_call", { tool: "execute", callId: `call-${id}` }]],
        );
      await raw.query("ALTER TABLE legacy_tape_steps ADD CONSTRAINT refuse_all CHECK (false) NOT VALID");

      await assert.rejects(
        raw.query("CALL prepare_legacy_tape_steps(50)"),
        /every session in the batch after \(start\) failed, so the failure is not in the data: 23514/,
      );

      assert.deepEqual(await progress(raw), {
        last_session: null,
        done: false,
        invalid_messages: 0,
        keyed_blocks: 0,
        copied_steps: 0,
        copied_turns: 0,
      });
      assert.equal((await raw.query("SELECT count(*)::int AS n FROM legacy_tape_skipped")).rows[0].n, 0);
    });
  },
);

test("pg legacy tape step preparation stops once more than 100 sessions have been skipped", { skip }, async () => {
  await withSchema(async (raw) => {
    await raw.query(
      `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at)
       SELECT 's' || lpad(g::text, 3, '0'), 'dm', $1, 'web:s' || g, 1 FROM generate_series(1, 202) g`,
      [scope],
    );
    await raw.query(
      `INSERT INTO session_tape(session_id, seq, kind, harness, payload, scope_label, created_at)
       SELECT 's' || lpad(g::text, 3, '0'), 0, 'message', 'pi',
              '{"role":"assistant","content":[{"type":"toolCall","id":"call-' || g || '","name":"execute","arguments":{}}]}', $1, 1
         FROM generate_series(1, 202, 2) g`,
      [scope],
    );
    await raw.query(
      `INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at)
       SELECT 's' || lpad(g::text, 3, '0'), 0, NULL, 'tool_call', '{"tool":"execute","callId":"call-' || g || '"}', $1, 0
         FROM generate_series(1, 202, 2) g`,
      [scope],
    );
    await raw.query("ALTER TABLE legacy_tape_steps ADD CONSTRAINT refuse_all CHECK (false) NOT VALID");

    await assert.rejects(
      raw.query("CALL prepare_legacy_tape_steps(50)"),
      /more than 100 sessions could not be prepared, so the failure is unlikely to be in the data: 23514/,
    );

    const state = (await raw.query("SELECT done, skipped_sessions::int AS skipped FROM legacy_tape_steps_progress"))
      .rows[0];
    assert.equal(state.done, false);
    assert.ok(state.skipped <= 100, `skipped ${state.skipped}`);
  });
});
