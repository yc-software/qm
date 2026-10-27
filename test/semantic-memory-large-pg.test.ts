import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresVectorStore } from "../src/memory/postgres-vector-store.ts";

const url = process.env.DATABASE_URL;

test("a 4500-fact scope fully drains 3072-dimensional recall in under one second", { skip: !url }, async (t) => {
  const scope = `personal:large-${randomUUID()}`;
  const model = `large-${randomUUID()}`;
  const base = createPostgresMemoryService(url!);
  const index = createPostgresVectorStore(url!);
  const client = new pg.Client({ connectionString: url! });
  await client.connect();
  t.after(async () => {
    await client.end();
    await index.close();
  });
  await base.facts!(scope);
  await index.missing(model, 1);
  await client.query(
    `INSERT INTO memory_facts(scope_id, text, sensitivity, source_unknown, created_at, updated_at)
    SELECT $1, 'Large notebook fact ' || g, 'ordinary', false, g, g FROM generate_series(1,4500) g`,
    [scope],
  );
  const vector = Array.from({ length: 3072 }, (_, i) => Math.sin(i * 123.4567));
  await client.query(
    `INSERT INTO memory_fact_vectors(scope_id, model, fact_id, fact_hash, dimensions, embedding)
    SELECT scope_id, $2, id, encode(sha256(convert_to(text,'UTF8')),'hex'), 3072, $3::vector
    FROM memory_facts WHERE scope_id = $1 AND created_at <= 4490`,
    [scope, model, JSON.stringify(vector)],
  );
  await client.query("ANALYZE memory_facts; ANALYZE memory_fact_vectors");
  const facts = await base.facts!(scope);
  const start = performance.now();
  const matches = await index.search({ scope, model, vector, ids: facts.map((fact) => fact.id) });
  const elapsed = performance.now() - start;
  assert.equal(matches.length, 4500);
  assert.ok(matches.slice(0, 4490).every((row) => row.score > 0.99));
  assert.ok(matches.slice(4490).every((row) => Math.abs(row.score - 0.2) < 1e-9));
  assert.equal(matches[0]!.factId, facts[4489]!.id);
  assert.ok(elapsed < 1000, `4500-fact full drain took ${elapsed.toFixed(1)}ms`);
  t.diagnostic(`4500 facts / 3072 dimensions / full drain: ${elapsed.toFixed(1)}ms`);
});
