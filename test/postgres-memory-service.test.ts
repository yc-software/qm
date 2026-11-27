import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { MemoryFactsMissing } from "../src/memory/facts.ts";
import { scopeId } from "../src/types.ts";
import { recallAcrossScopes, searchAcrossScopes } from "../src/memory/cross-scope.ts";

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
  await sql("DELETE FROM memory_facts");
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
