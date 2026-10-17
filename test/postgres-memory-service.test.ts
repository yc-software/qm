import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { MemoryFactsMissing } from "../src/memory/facts.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres memory tests";
const at = Date.UTC(2026, 4, 31);

async function sql(text: string, params: unknown[] = []) {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: URL });
  try {
    return (await pool.query(text, params)).rows;
  } finally {
    await pool.end();
  }
}

beforeEach(async () => {
  if (!URL) return;
  await sql("DROP TABLE IF EXISTS qm_schema_migrations, memory_revisions, memory_facts CASCADE");
});

test("pg memory: notebook snapshots migrate into one row per fact, in order", { skip }, async () => {
  await sql(`CREATE TABLE memory_revisions(id BIGSERIAL PRIMARY KEY, scope_id TEXT NOT NULL, seq BIGINT NOT NULL,
    op TEXT NOT NULL, body TEXT NOT NULL, author TEXT, at BIGINT NOT NULL, records JSONB, UNIQUE (scope_id, seq))`);
  const records = {
    version: 1,
    capturesSinceConsolidation: 3,
    records: [
      { id: "a", text: "# Memory", sensitivity: "unknown", sources: [], sourceUnknown: true },
      {
        id: "b",
        text: "- (2026-05-01) Prefers terse replies",
        sensitivity: "sensitive",
        sources: [{ scopeId: "channel:C1", sessionId: "s1" }, { scopeId: "channel:C1" }],
        sourceUnknown: false,
      },
    ],
  };
  await sql(
    "INSERT INTO memory_revisions(scope_id, seq, op, body, at, records) VALUES ($1, 1, 'capture', '', $2, $3)",
    ["personal:U1", at, { ...records, records: [] }],
  );
  await sql(
    "INSERT INTO memory_revisions(scope_id, seq, op, body, at, records) VALUES ($1, 2, 'capture', '', $2, $3)",
    ["personal:U1", at, records],
  );
  await sql("INSERT INTO memory_revisions(scope_id, seq, op, body, at) VALUES ($1, 1, 'replace', $2, $3)", [
    "personal:U2",
    "# Memory\n\nIntro paragraph\nthat wraps.\n- (2026-04-01) Owns billing\n<!-- consolidated: 2026-04-02 -->\n* Second fact\n## Projects\nWorks on search.\n- (2026-02-30) Bad date\n- (2026-10-01)\n",
    at,
  ]);

  const memory = createPostgresMemoryService(URL!);
  const one = await memory.facts!("personal:U1");
  assert.deepEqual(
    one.map(({ text, sensitivity, sources, sourceUnknown }) => ({ text, sensitivity, sources, sourceUnknown })),
    [{ text: "Prefers terse replies", sensitivity: "sensitive", sources: ["channel:C1"], sourceUnknown: false }],
  );
  assert.equal(await memory.read("personal:U1"), "- (2026-05-01) Prefers terse replies");
  const legacy = await memory.facts!("personal:U2");
  assert.deepEqual(
    legacy.map((fact) => fact.text),
    ["Intro paragraph\nthat wraps.", "Owns billing", "Second fact", "Works on search.", "Bad date"],
  );
  assert.equal(legacy[1]!.createdAt, Date.UTC(2026, 3, 1));
  assert.equal(legacy[2]!.createdAt, at);
  assert.equal(legacy[4]!.createdAt, at);
});

test("pg memory: add, edit and delete by id; a bad id rolls back the whole call", { skip }, async () => {
  const memory = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "U1");
  assert.equal(await memory.capture(sid, ["Prefers terse replies", "Owns billing"], at, "U1"), 2);
  assert.equal(await memory.capture(sid, ["prefers terse replies"], at, "U1"), 0);
  const [terse, billing] = await memory.facts!(sid);

  await assert.rejects(
    memory.edit!(sid, [
      { id: terse!.id, text: "Prefers short replies" },
      { id: "999999", text: "x" },
    ]),
    (e: unknown) => e instanceof MemoryFactsMissing && e.ids.join() === "999999",
  );
  await assert.rejects(memory.delete!(scopeId("personal", "U2"), [billing!.id]), MemoryFactsMissing);
  assert.equal(await memory.read(sid), "- (2026-05-31) Prefers terse replies\n- (2026-05-31) Owns billing");

  await memory.edit!(sid, [{ id: `#${terse!.id}`, text: "- (2020-01-01) Prefers short replies" }]);
  await memory.delete!(sid, [billing!.id]);
  const second = createPostgresMemoryService(URL!);
  assert.deepEqual(await second.query(sid, "short", 5), [`#${terse!.id} (2026-05-31) Prefers short replies`]);
  assert.equal(await second.read(sid), "- (2026-05-31) Prefers short replies");
  const [row] = await sql("SELECT deleted_at FROM memory_facts WHERE id = $1", [billing!.id]);
  assert.ok(row?.deleted_at, "delete keeps the row, marked deleted");
});

test("pg memory: an empty normalized edit rolls back the entire batch", { skip }, async () => {
  const memory = createPostgresMemoryService(URL!);
  const scope = scopeId("personal", "editor");
  await memory.capture(scope, ["First retained fact", "Second retained fact"], at);
  const original = await memory.facts!(scope);
  await assert.rejects(
    memory.edit!(scope, [
      { id: original[0]!.id, text: "Should not commit" },
      { id: original[1]!.id, text: "- (2026-01-01)" },
    ]),
    /non-empty/,
  );
  assert.deepEqual(await memory.facts!(scope), original);
});
