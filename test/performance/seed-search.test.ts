import assert from "node:assert/strict";
import { test } from "node:test";
import { registeredPgMigrations } from "../../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { bindSearchText, SEARCH_BINDING_SQL, searchPayloads } from "./seed-search.ts";
import { validateTarget } from "./seed.ts";

const aggregates = {
  search_native_vector_widths: [{ type: "user", lexemes_mean: 4, lexemes_quantiles: [3, 6, 8, 10], lexemes_max: 12 }],
  search_sample_vocabulary_shape: [
    {
      type: "user",
      sampled_rows: 100,
      distinct_sample_lexemes: 120,
      singleton_lexemes: 20,
      document_lexeme_pairs: 400,
      lexeme_bytes_mean: 4,
      lexeme_bytes: [3, 5, 6, 8],
      lexeme_bytes_max: 12,
      documents_per_lexeme: [1, 5, 8, 20],
      max_documents_per_lexeme: 75,
    },
  ],
  search_lexical_generation: [{ type: "user", frequency_exponent: 1 }],
};

test("search words preserve native payload fields, visibility, formatting and exact serialized length", () => {
  const bodies = [
    "QM performance fixture " + "a".repeat(100) + "\n" + "b".repeat(80),
    "```text\nQM performance fixture\n```\n" + "c".repeat(90),
    "| Fixture | Value |\n| --- | --- |\n| QM | performance |\n" + "d".repeat(90),
    "Q",
    "",
  ];
  const input = bodies.map((body) => ({
    body,
    payload: { ...(body ? { text: body } : {}), context: "0qayzzzz context", preview: "0qbyzzzz preview" },
  }));
  const actual = searchPayloads("user", input, aggregates);
  assert.deepEqual(actual, searchPayloads("user", input, aggregates));
  assert.equal(searchPayloads("tool_result", input, aggregates), input);
  for (let i = 0; i < input.length; i++) {
    assert.equal(actual[i]!.body.length, input[i]!.body.length);
    assert.equal(actual[i]!.body.split("\n").length, input[i]!.body.split("\n").length);
    assert.equal(Boolean(actual[i]!.body.trim()), Boolean(input[i]!.body.trim()));
    assert.equal(actual[i]!.payload.context, input[i]!.payload.context);
    assert.equal(actual[i]!.payload.preview, input[i]!.payload.preview);
    assert.equal(JSON.stringify(actual[i]!.payload).length, JSON.stringify(input[i]!.payload).length);
  }
  assert.ok(actual[1]!.body.startsWith("```text\nQM performance fixture\n```\n"));
  assert.ok(actual[2]!.body.startsWith("| Fixture | Value |\n| --- | --- |\n| QM | performance |\n"));
  assert.throws(
    () => searchPayloads("user", input, { search_native_vector_widths: aggregates.search_native_vector_widths }),
    /requires vocabulary/,
  );
});

test("identity rebinding only replaces complete rare markers and preserves width", () => {
  const text = "QM PERF sample first 0qayzzzz 0qayzzzzlong 0qayzzzz\nunchanged";
  const first = bindSearchText(text, "session:1");
  assert.equal(first.length, text.length);
  assert.equal(first, bindSearchText(text, "session:1"));
  assert.notEqual(first, bindSearchText(text, "session:2"));
  assert.ok(first.startsWith("QM PERF sample first "));
  assert.ok(first.endsWith("\nunchanged"));
  assert.ok(!first.includes("0q"));
  const words = first.split(/\s+/);
  assert.equal(words[4], words[6]);
  assert.notEqual(words[4], words[5]!.slice(0, words[4]!.length));
});

test(
  "native PostgreSQL entry trigger and tape retain the same bound text without changing preview or context",
  {
    skip: process.env.QM_PERF_TEST_DATABASE_URL
      ? false
      : "set QM_PERF_TEST_DATABASE_URL to an isolated database for temporary PostgreSQL check",
  },
  async () => {
    const url = process.env.QM_PERF_TEST_DATABASE_URL!;
    validateTarget(url, new URL(url).pathname.slice(1));
    const pg = (await import("pg")).default;
    const db = new pg.Client({ connectionString: url, options: "-c statement_timeout=10000" });
    await db.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL search_path=pg_temp,public");
      await db.query(
        "CREATE TEMP TABLE session_entries(session_id text,seq int,type text,payload text,created_at bigint,PRIMARY KEY(session_id,seq));CREATE TEMP TABLE session_entry_search(session_id text,seq int,type text,author text,text text,created_at bigint,search_tsv tsvector GENERATED ALWAYS AS(to_tsvector('simple',text)) STORED,PRIMARY KEY(session_id,seq));CREATE TEMP TABLE session_tape(session_id text,seq int,payload text,PRIMARY KEY(session_id,seq))",
      );
      for (const table of ["session_entries", "session_entry_search", "session_tape"])
        assert.equal(
          (await db.query("SELECT relpersistence FROM pg_class WHERE oid=$1::regclass", [table])).rows[0]
            .relpersistence,
          "t",
        );
      createPostgresSessionStore(url);
      const functions = registeredPgMigrations(url)
        .flatMap((migration) => migration.statements)
        .filter((sql) =>
          /^CREATE OR REPLACE FUNCTION (safe_json|entry_search_text|sync_session_entry_search)\(/.test(sql),
        );
      assert.equal(functions.length, 3);
      for (const sql of functions)
        await db.query(sql.replace(/\b(safe_json|entry_search_text|sync_session_entry_search)\(/g, "pg_temp.$1("));
      await db.query(
        "CREATE TRIGGER search_write_through AFTER INSERT OR UPDATE OR DELETE ON pg_temp.session_entries FOR EACH ROW EXECUTE FUNCTION pg_temp.sync_session_entry_search()",
      );
      await db.query(SEARCH_BINDING_SQL);
      const payload = {
        text: "QM PERF session first 0qayzzzz 0qayzzzzlong 0qbyzzzz",
        context: "0qayzzzz unchanged",
        preview: "0qbyzzzz unchanged",
      };
      for (let seq = 0; seq < 2; seq++) {
        await db.query(
          "INSERT INTO pg_temp.session_entries VALUES('session',$1::int,'user',pg_temp.perf_bind_search($2::jsonb,'session:'||($1::int)::text)::text,123)",
          [seq, JSON.stringify(payload)],
        );
      }
      await db.query(
        "INSERT INTO pg_temp.session_tape SELECT session_id,seq,jsonb_build_object('event','transcript_entry','entry',jsonb_build_object('type',type,'payload',payload::jsonb,'at',created_at))::text FROM pg_temp.session_entries",
      );
      const rows = (
        await db.query(
          "SELECT e.seq,e.payload,s.text,s.search_tsv,t.payload::jsonb#>>'{entry,payload,text}' AS tape_text FROM pg_temp.session_entries e JOIN pg_temp.session_entry_search s USING(session_id,seq) JOIN pg_temp.session_tape t USING(session_id,seq) ORDER BY e.seq",
        )
      ).rows;
      assert.equal(rows.length, 2);
      for (const row of rows) {
        const actual = JSON.parse(row.payload);
        assert.equal(actual.text, bindSearchText(payload.text, `session:${row.seq}`));
        assert.equal(actual.context, payload.context);
        assert.equal(actual.preview, payload.preview);
        assert.equal(row.text, actual.text);
        assert.equal(row.tape_text, actual.text);
        assert.ok(!row.search_tsv.includes("0q"));
      }
      assert.notEqual(rows[0].text, rows[1].text);
      await db.query("UPDATE pg_temp.session_entries SET payload=$1 WHERE seq=0", [
        JSON.stringify({ context: "metadata-only" }),
      ]);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_temp.session_entry_search")).rows[0].n, 1);
    } finally {
      await db.query("ROLLBACK").catch(() => {});
      await db.end();
    }
  },
);
