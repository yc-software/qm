import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresVectorStore } from "../src/memory/postgres-vector-store.ts";

const url = process.env.DATABASE_URL;

test(
  "a 4500-fact 3072-dimensional scope returns its nearest facts, then unindexed ones, up to the limit",
  { skip: !url },
  async (t) => {
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
    await client.query(
      `INSERT INTO memory_fact_vectors(scope_id, model, fact_id, fact_hash, dimensions, embedding)
    SELECT scope_id, $2, id, text_hash, 3072, ARRAY(
      SELECT CASE WHEN created_at % 449 = 0
        THEN sin(d * 123.4567) + 0.02 * (created_at / 449) * sin(created_at * 1000 + d)
        ELSE sin(created_at * 1000 + d) END
      FROM generate_series(1, 3072) d
    )::vector
    FROM memory_facts WHERE scope_id = $1 AND created_at <= 4490`,
      [scope, model],
    );
    const facts = await base.facts!(scope);
    const vector = Array.from({ length: 3072 }, (_, i) => Math.sin((i + 1) * 123.4567));
    const matches = await index.search({ scope, model, vector, ids: facts.map((fact) => fact.id), limit: 15 });
    const byCreated = new Map(facts.map((fact) => [fact.id, fact.createdAt]));
    assert.deepEqual(
      matches.map((row) => byCreated.get(row.factId)),
      [449, 898, 1347, 1796, 2245, 2694, 3143, 3592, 4041, 4490, 4500, 4499, 4498, 4497, 4496],
    );
    assert.ok(matches.slice(0, 10).every((row) => row.score > 0.97));
    assert.ok(matches.slice(10).every((row) => Math.abs(row.score - 0.2) < 1e-9));
  },
);
