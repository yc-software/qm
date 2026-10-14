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

async function seedSession(raw: import("pg").Pool, id: string, tape: string[], entries: Array<[string, unknown]>) {
  await raw.query("INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ($1, 'dm', $2, $3, 1)", [
    id,
    scope,
    `web:${id}`,
  ]);
  for (const [seq, payload] of tape.entries())
    await raw.query(
      "INSERT INTO session_tape(session_id, seq, kind, payload, scope_label, created_at) VALUES ($1, $2, 'message', $3, $4, 1)",
      [id, seq, payload, scope],
    );
  for (const [seq, [type, payload]] of entries.entries())
    await raw.query(
      "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1, $2, NULL, $3, $4, $5, $6)",
      [id, seq, type, JSON.stringify(payload), scope, seq * 100],
    );
}

test(
  "pg legacy tape steps keep each step's model and exact tool arguments, and map turns to runs",
  { skip },
  async () => {
    await withSchema(async (raw) => {
      await seedSession(
        raw,
        "legacy",
        [
          message([
            { type: "thinking", thinking: "plan", thinkingSignature: "sig-1" },
            { type: "text", text: "Checking." },
            { type: "toolCall", id: "c1", name: "execute", arguments: { z: 1, a: { b: 2 } }, thoughtSignature: "ts" },
          ]),
          message([
            { type: "text", text: "Same" },
            { type: "text", text: "Same" },
          ]),
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
        ],
      );
      await seedSession(raw, "tapeless", [], [["user", { text: "hi" }]]);
      await raw.query(
        "INSERT INTO runs(id, session_id, status, request, created_at, turn_user_seq, started_at, finished_at) VALUES ('run-a', 'web:legacy', 'done', '{}', 1, 5, 450, 650), ('run-b', 'web:legacy', 'done', '{}', 1, NULL, 650, 900)",
      );

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
          { session_id: "legacy", seq: 1, step: step(1), wire: null },
          {
            session_id: "legacy",
            seq: 2,
            step: step(2),
            wire: { argumentsJson: '{"z":1,"a":{"b":2}}', thoughtSignature: "ts" },
          },
        ],
      );
      assert.deepEqual(
        (await raw.query("SELECT session_id, seq, run_id, inferred FROM legacy_turn_runs ORDER BY session_id, seq"))
          .rows,
        [
          { session_id: "legacy", seq: 5, run_id: "run-a", inferred: false },
          { session_id: "legacy", seq: 7, run_id: "run-b", inferred: true },
        ],
      );
      const progress = (await raw.query("SELECT * FROM legacy_tape_steps_progress")).rows[0];
      assert.equal(progress.done, true);
      assert.equal(progress.tape_written, false);
      assert.equal(progress.last_session, "tapeless");
      assert.ok(Number(progress.started_at) > 0);
      assert.equal((await raw.query("SELECT to_regclass('legacy_prep_runs') AS t")).rows[0].t, null);
    });
  },
);

test(
  "pg legacy tape step preparation resumes after an interruption and flags any later tape write",
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
      await raw.query("UPDATE legacy_tape_steps_progress SET last_session = 's1', started_at = 1");
      await raw.query(
        "CREATE TRIGGER legacy_tape_frozen AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON session_tape FOR EACH STATEMENT EXECUTE FUNCTION legacy_tape_written()",
      );

      await raw.query("CALL prepare_legacy_tape_steps(1)");

      assert.deepEqual(
        (await raw.query("SELECT session_id FROM legacy_tape_steps ORDER BY session_id")).rows.map((r) => r.session_id),
        ["s2", "s3"],
      );
      const progress = (await raw.query("SELECT started_at, done, tape_written FROM legacy_tape_steps_progress"))
        .rows[0];
      assert.deepEqual(progress, { started_at: "1", done: true, tape_written: false });

      await raw.query("DELETE FROM session_tape WHERE session_id = 'none'");
      assert.equal((await raw.query("SELECT tape_written FROM legacy_tape_steps_progress")).rows[0].tape_written, true);
    });
  },
);
