import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { MemoryFactsMissing } from "../src/memory/facts.ts";
import { scopeId } from "../src/types.ts";
import { recallAcrossScopes, searchAcrossScopes } from "../src/memory/cross-scope.ts";
import { withTenant } from "../src/tenants/context.ts";

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

test("pg memory: notebooks written before the records column migrate into fact rows", { skip }, async () => {
  await sql(`CREATE TABLE memory_revisions(id BIGSERIAL PRIMARY KEY, scope_id TEXT NOT NULL, seq BIGINT NOT NULL,
    op TEXT NOT NULL, body TEXT NOT NULL, author TEXT, at BIGINT NOT NULL, UNIQUE (scope_id, seq))`);
  await sql("INSERT INTO memory_revisions(scope_id, seq, op, body, at) VALUES ($1, 1, 'replace', $2, $3)", [
    "personal:U3",
    "# Memory\n- (2026-04-01) Owns billing\n",
    at,
  ]);
  const memory = createPostgresMemoryService(URL!);
  assert.deepEqual(
    (await memory.facts!("personal:U3")).map((fact) => fact.text),
    ["Owns billing"],
  );
});

test("pg memory: add, edit and delete by id; a bad id rolls back the whole call", { skip }, async () => {
  const memory = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "U1");
  assert.equal(
    await memory.capture(sid, ["Prefers terse replies", "Owns billing"], at, {
      actorId: "U1",
      context: "conversation",
    }),
    2,
  );
  assert.equal(await memory.capture(sid, ["prefers terse replies"], at, { actorId: "U1", context: "conversation" }), 0);
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
  assert.deepEqual(
    (await second.query(sid, "short", 5)).map(({ text }) => text),
    [`#${terse!.id} (2026-05-31) Prefers short replies`],
  );
  assert.equal(await second.read(sid), "- (2026-05-31) Prefers short replies");
  const [row] = await sql("SELECT deleted_at FROM memory_facts WHERE id = $1", [billing!.id]);
  assert.ok(row?.deleted_at, "delete keeps the row, marked deleted");
});

test("pg memory: the capturing session is stored and that session never gets the fact back", { skip }, async () => {
  const memory = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "U1");
  await memory.capture(
    sid,
    ["Owns billing"],
    at,
    { actorId: "U1", context: "self" },
    { mode: "automatic", sessionId: "S" },
  );
  await memory.capture(sid, ["Prefers terse replies"], at, { actorId: "U1", context: "self" });
  const [billing, terse] = await memory.facts!(sid);
  assert.equal(billing!.sessionId, "S");
  assert.equal(terse!.sessionId, undefined);
  const recalled = async (sessionId: string) =>
    (await recallAcrossScopes(memory, [sid], { sessionId })).map((fact) => fact.text);
  assert.deepEqual(await recalled("S"), ["- (2026-05-31) Prefers terse replies"]);
  assert.deepEqual(await recalled("T"), ["- (2026-05-31) Prefers terse replies", "- (2026-05-31) Owns billing"]);
  assert.deepEqual(await searchAcrossScopes(memory, [sid], "billing", 20, { sessionId: "S" }), []);
  assert.equal((await searchAcrossScopes(memory, [sid], "billing", 20, { sessionId: "T" })).length, 1);
});

test("pg memory: a write through one instance is visible to the next read on another", { skip }, async () => {
  const writer = createPostgresMemoryService(URL!);
  const reader = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "U1");
  const seen = async () =>
    (await reader.facts!(sid)).map(({ text, sensitivity, sources }) => `${text}|${sensitivity}|${sources.join()}`);
  assert.deepEqual(await seen(), []);
  await writer.capture(sid, ["Owns billing"], at, { actorId: "U1", context: "self" });
  assert.deepEqual(await seen(), ["Owns billing|unknown|personal:U1"]);
  await writer.capture(
    sid,
    ["Owns billing"],
    at,
    { actorId: "U1", context: "self" },
    {
      mode: "explicit",
      sensitivity: "sensitive",
      conversationScopeId: scopeId("channel", "C1"),
    },
  );
  const [merged] = await seen();
  assert.notEqual(merged, "Owns billing|unknown|personal:U1");
  const [fact] = await reader.facts!(sid);
  await writer.edit!(sid, [{ id: fact!.id, text: "Owns billinG" }]);
  assert.match((await seen())[0]!, /^Owns billinG\|/);
  await writer.delete!(sid, [fact!.id]);
  assert.deepEqual(await seen(), []);
});

test("pg memory: the same scope id in two tenants never shares a notebook", { skip }, async () => {
  const other = "00000000-0000-4000-8000-000000000002";
  await sql("INSERT INTO tenants(id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [other]);
  const memory = createPostgresMemoryService(URL!);
  const sid = scopeId("personal", "U1");
  const texts = async () => (await memory.facts!(sid)).map((fact) => fact.text);
  await memory.capture(sid, ["Home tenant fact"], at);
  assert.deepEqual(await texts(), ["Home tenant fact"]);
  assert.deepEqual(await withTenant(other, texts), []);
  await withTenant(other, () => memory.capture(sid, ["Other tenant fact"], at));
  assert.deepEqual(await withTenant(other, texts), ["Other tenant fact"]);
  assert.deepEqual(await texts(), ["Home tenant fact"]);
});
