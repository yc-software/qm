import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresVectorStore, type MemoryVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createSemanticMemoryService } from "../src/memory/semantic-recall.ts";
import { factHash, type MemoryFact } from "../src/memory/facts.ts";

const url = process.env.DATABASE_URL;
const ids = (facts: readonly MemoryFact[]) => facts.map((fact) => fact.id);
const write = (
  store: MemoryVectorStore,
  scope: string,
  facts: readonly MemoryFact[],
  model = "test-v1",
  vector: (fact: MemoryFact) => number[] = () => [1, 0],
) =>
  store.put(facts.map((fact) => ({ scope, model, factId: fact.id, hash: factHash(fact.text), vector: vector(fact) })));

test(
  "Postgres native cosine persists across instances and treats edited/deleted facts as unindexed/gone",
  { skip: !url },
  async (t) => {
    const scope = `personal:semantic-${randomUUID()}`;
    const base = createPostgresMemoryService(url!);
    const index = createPostgresVectorStore(url!);
    t.after(() => index.close());
    await base.capture(scope, ["original browser preference"], Date.now());
    const facts = await base.facts!(scope);
    await write(index, scope, facts);
    const search = () => index.search({ scope, model: "test-v1", vector: [1, 0], ids: ids(facts), limit: 100 });
    assert.equal((await search())[0]!.factId, facts[0]!.id);
    const secondIndex = createPostgresVectorStore(url!);
    t.after(() => secondIndex.close());
    const calls: string[][] = [];
    const memory = createSemanticMemoryService(
      base,
      async () => ({
        id: "test-v1",
        async embed(texts) {
          calls.push(texts);
          return texts.map(() => [1, 0]);
        },
      }),
      secondIndex,
    );
    assert.match((await memory.recall(scope, { query: "verify" }))[0]!.text, /original/);
    assert.deepEqual(calls, [["verify"]]);
    assert.equal((await search())[0]!.hash, factHash("original browser preference"));
    await base.edit!(scope, [{ id: facts[0]!.id, text: "revised browser preference" }]);
    const stale = await search();
    assert.deepEqual(
      stale.map((row) => [row.factId, row.hash]),
      [[facts[0]!.id, factHash("revised browser preference")]],
    );
    assert.ok(Math.abs(stale[0]!.score - 0.2) < 1e-9);
    assert.match((await memory.recall(scope, { query: "verify" }))[0]!.text, /revised/);
    const revised = await base.facts!(scope);
    const unindexed = await index.search({
      scope,
      model: "test-v1",
      vector: [1, 0],
      ids: ids(revised),
      limit: 100,
      minSimilarity: 0.9,
    });
    assert.deepEqual(
      unindexed.map((row) => row.factId),
      [revised[0]!.id],
    );
    assert.ok(Math.abs(unindexed[0]!.score - 0.2) < 1e-9);
    await write(index, scope, revised);
    assert.equal(
      (await index.search({ scope, model: "test-v1", vector: [1, 0], ids: ids(revised), limit: 100 }))[0]!.score,
      1,
    );
    await base.delete!(scope, [facts[0]!.id]);
    assert.deepEqual(await search(), []);
    assert.deepEqual(
      await index.search({ scope, model: "test-v1", vector: [1, 0], ids: ids(revised), limit: 100 }),
      [],
    );
    assert.deepEqual(await memory.recall(scope, { query: "verify" }), []);
    assert.ok(!(await index.missing("test-v1", 256)).some((row) => row.factId === facts[0]!.id));
  },
);

test("native cosine returns one stable ranking and excludes other scopes/models", { skip: !url }, async (t) => {
  const scope = `personal:ranking-${randomUUID()}`;
  const base = createPostgresMemoryService(url!);
  const index = createPostgresVectorStore(url!);
  t.after(() => index.close());
  await base.capture(scope, ["first", "second"], 1000);
  const facts = await base.facts!(scope);
  await write(index, scope, facts, "rank-model", () => [3, 4]);
  await write(index, scope, facts, "other-model", () => [1, 0]);
  await write(index, "personal:other", facts, "rank-model", () => [1, 0]);
  const ranked = await index.search({ scope, model: "rank-model", vector: [2, 0], ids: ids(facts), limit: 100 });
  assert.ok(ranked.every((row) => Math.abs(row.score - 0.6) < 1e-6));
  assert.deepEqual(
    await index.search({ scope, model: "rank-model", vector: [2, 0], ids: ids(facts), limit: 100, minSimilarity: 0.9 }),
    [],
  );
  assert.deepEqual(
    ranked.map((row) => row.factId),
    facts.map((fact) => fact.id).sort((a, b) => Number(BigInt(a) - BigInt(b))),
  );
});

test("model and dimension drift fall back until reindexed", { skip: !url }, async (t) => {
  const scope = `personal:width-${randomUUID()}`;
  const base = createPostgresMemoryService(url!);
  const index = createPostgresVectorStore(url!);
  t.after(() => index.close());
  await base.capture(scope, ["real embedding width"], 1000);
  const facts = await base.facts!(scope);
  const wide = [1, 0, 0];
  await write(index, scope, facts, "wide-model", () => wide);
  const unindexedScore = async (model: string, vector: number[]) => {
    const rows = await index.search({ scope, model, vector, ids: ids(facts), limit: 100 });
    return rows.length === 1 && Math.abs(rows[0]!.score - 0.2) < 1e-9;
  };
  assert.ok(await unindexedScore("wide-model", [1, 0]));
  assert.ok(await unindexedScore("new-model", wide));
  assert.ok(
    (await index.missing("wide-model", 256, 2, undefined, String(BigInt(facts[0]!.id) - 1n))).some(
      (row) => row.factId === facts[0]!.id,
    ),
  );
  assert.ok(
    !(await index.missing("wide-model", 256, 2, undefined, facts[0]!.id)).some((row) => row.factId === facts[0]!.id),
  );
  await write(index, scope, facts, "wide-model", () => [1, 0]);
  assert.equal(
    (await index.search({ scope, model: "wide-model", vector: [1, 0], ids: ids(facts), limit: 100 }))[0]!.score,
    1,
  );
  await assert.rejects(
    index.put([{ scope, model: "wide-model", factId: facts[0]!.id, hash: factHash(facts[0]!.text), vector: [0, 0] }]),
    /Invalid memory embedding/,
  );
});

const storedVectors = async (client: pg.Client, scope: string, model: string) =>
  (
    await client.query(
      `SELECT fact_id, fact_hash, dimensions, embedding::text AS embedding FROM memory_fact_vectors
       WHERE scope_id = $1 AND model = $2 ORDER BY fact_id`,
      [scope, model],
    )
  ).rows as { fact_id: string; fact_hash: string; dimensions: number; embedding: string }[];

test("put waits on in-flight edits and never writes stale or deleted fact vectors", { skip: !url }, async (t) => {
  const scope = `personal:race-${randomUUID()}`;
  const model = `race-${randomUUID()}`;
  const base = createPostgresMemoryService(url!);
  const index = createPostgresVectorStore(url!);
  const client = new pg.Client({ connectionString: url! });
  await client.connect();
  t.after(async () => {
    await client.end();
    await index.close();
  });
  await base.capture(scope, ["race alpha", "race beta"], 1000);
  const [alpha, beta] = await base.facts!(scope);
  await client.query("BEGIN");
  await client.query("UPDATE memory_facts SET text = 'race alpha edited' WHERE id = $1", [alpha!.id]);
  let settled = false;
  const pending = write(index, scope, [alpha!, beta!], model).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false);
  await client.query("COMMIT");
  await pending;
  assert.deepEqual(
    (await storedVectors(client, scope, model)).map((row) => row.fact_id),
    [beta!.id],
  );
  const edited = (await base.facts!(scope)).find((fact) => fact.id === alpha!.id)!;
  await write(index, scope, [edited], model, () => [0, 1]);
  await write(index, scope, [alpha!], model, () => [1, 0]);
  const fresh = (await storedVectors(client, scope, model)).find((row) => row.fact_id === alpha!.id)!;
  assert.equal(fresh.fact_hash, factHash("race alpha edited"));
  assert.equal(fresh.embedding, "[0,1]");
  await base.delete!(scope, [beta!.id]);
  await write(index, scope, [beta!], model, () => [0, 1]);
  assert.equal((await storedVectors(client, scope, model)).find((row) => row.fact_id === beta!.id)!.embedding, "[1,0]");
  while (await index.prune(model, 256, 2));
  assert.deepEqual(
    (await storedVectors(client, scope, model)).map((row) => row.fact_id),
    [alpha!.id],
  );
});

test("prune deletes stale model, hash, deleted, and dimension rows in bounded batches", { skip: !url }, async (t) => {
  const scope = `personal:prune-${randomUUID()}`;
  const model = `prune-${randomUUID()}`;
  const base = createPostgresMemoryService(url!);
  const index = createPostgresVectorStore(url!);
  const client = new pg.Client({ connectionString: url! });
  await client.connect();
  t.after(async () => {
    await client.end();
    await index.close();
  });
  await base.capture(scope, ["prune keep", "prune edit", "prune delete", "prune wide", "prune unknown width"], 1000);
  const [keep, edit, gone, wide, unknown] = await base.facts!(scope);
  await write(index, scope, [keep!, edit!, gone!, unknown!], model);
  await write(index, scope, [wide!], model, () => [1, 0, 0]);
  await write(index, scope, [keep!], `${model}-old`);
  await base.edit!(scope, [{ id: edit!.id, text: "prune edit revised" }]);
  await base.delete!(scope, [gone!.id]);
  assert.equal(await index.prune(model, 1, 2), 1);
  let removed = 1;
  for (let deleted = -1; deleted; removed += deleted) {
    deleted = await index.prune(model, 2, 2);
    assert.ok(deleted <= 2);
  }
  assert.ok(removed >= 4);
  assert.deepEqual(
    (await storedVectors(client, scope, model)).map((row) => row.fact_id),
    [keep!.id, unknown!.id],
  );
  assert.deepEqual(await storedVectors(client, scope, `${model}-old`), []);
  await write(index, scope, [wide!], model, () => [1, 0, 0]);
  while (await index.prune(model, 256));
  assert.deepEqual(
    (await storedVectors(client, scope, model)).map((row) => row.fact_id),
    [keep!.id, wide!.id, unknown!.id],
  );
});

test(
  "stored fact hashes match factHash and bound the ranked search to the requested facts",
  { skip: !url },
  async (t) => {
    const scope = `personal:hash-${randomUUID()}`;
    const base = createPostgresMemoryService(url!);
    const index = createPostgresVectorStore(url!);
    const client = new pg.Client({ connectionString: url! });
    await client.connect();
    t.after(async () => {
      await client.end();
      await index.close();
    });
    await base.capture(scope, ["café ☃ naïve", "second", "third", "fourth"], 1000);
    const facts = await base.facts!(scope);
    await base.edit!(scope, [{ id: facts[1]!.id, text: "second — edited ✓" }]);
    const edited = await base.facts!(scope);
    const stored = await client.query("SELECT id, text_hash FROM memory_facts WHERE scope_id = $1 ORDER BY id", [
      scope,
    ]);
    assert.deepEqual(
      stored.rows.map((row) => [String(row.id), row.text_hash]),
      edited.map((fact) => [fact.id, factHash(fact.text)]),
    );
    await write(index, scope, edited, "hash-model", (fact) => (fact.text.startsWith("third") ? [1, 0] : [1, 1]));
    const search = (wanted: readonly MemoryFact[], limit: number) =>
      index.search({ scope, model: "hash-model", vector: [1, 0], ids: ids(wanted), limit });
    const top = await search(edited, 2);
    assert.equal(top.length, 2);
    assert.equal(top[0]!.factId, edited[2]!.id);
    assert.equal(top[0]!.hash, factHash("third"));
    const subset = await search([edited[0]!, edited[1]!], 100);
    assert.deepEqual(subset.map((row) => row.factId).sort(), [edited[0]!.id, edited[1]!.id].sort());
    assert.deepEqual(await search([], 100), []);
    assert.deepEqual(
      (await index.missing("hash-model", 256)).filter((row) => row.scope === scope),
      [],
    );
  },
);
