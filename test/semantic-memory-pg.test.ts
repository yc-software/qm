import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresVectorStore, type MemoryVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createSemanticMemoryService } from "../src/memory/semantic-recall.ts";
import { factHash, type MemoryFact } from "../src/memory/facts.ts";
import { createNearDuplicateFinder } from "../src/memory/near-duplicates.ts";

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
    const search = () => index.search({ scope, model: "test-v1", vector: [1, 0], ids: ids(facts) });
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
    await base.edit!(scope, [{ id: facts[0]!.id, text: "revised browser preference" }]);
    const stale = await search();
    assert.deepEqual(
      stale.map((row) => row.factId),
      [facts[0]!.id],
    );
    assert.notEqual(stale[0]!.updatedAt, facts[0]!.updatedAt);
    assert.ok(Math.abs(stale[0]!.score - 0.2) < 1e-9);
    assert.match((await memory.recall(scope, { query: "verify" }))[0]!.text, /revised/);
    const revised = await base.facts!(scope);
    const unindexed = await index.search({
      scope,
      model: "test-v1",
      vector: [1, 0],
      ids: ids(revised),
      minSimilarity: 0.9,
    });
    assert.deepEqual(
      unindexed.map((row) => row.factId),
      [revised[0]!.id],
    );
    assert.ok(Math.abs(unindexed[0]!.score - 0.2) < 1e-9);
    await write(index, scope, revised);
    assert.equal((await index.search({ scope, model: "test-v1", vector: [1, 0], ids: ids(revised) }))[0]!.score, 1);
    await base.delete!(scope, [facts[0]!.id]);
    assert.deepEqual(await search(), []);
    assert.deepEqual(await index.search({ scope, model: "test-v1", vector: [1, 0], ids: ids(revised) }), []);
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
  const ranked = await index.search({ scope, model: "rank-model", vector: [2, 0], ids: ids(facts) });
  assert.ok(ranked.every((row) => Math.abs(row.score - 0.6) < 1e-6));
  assert.deepEqual(
    await index.search({ scope, model: "rank-model", vector: [2, 0], ids: ids(facts), minSimilarity: 0.9 }),
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
    const rows = await index.search({ scope, model, vector, ids: ids(facts) });
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
  assert.equal((await index.search({ scope, model: "wide-model", vector: [1, 0], ids: ids(facts) }))[0]!.score, 1);
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
  "stored fact hashes match factHash and the ranked search covers only the requested facts",
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
    const search = (wanted: readonly MemoryFact[]) =>
      index.search({ scope, model: "hash-model", vector: [1, 0], ids: ids(wanted) });
    const ranked = await search(edited);
    assert.equal(ranked[0]!.factId, edited[2]!.id);
    assert.equal(ranked[0]!.updatedAt, edited[2]!.updatedAt);
    assert.ok(Math.abs(ranked[0]!.score - 1) < 1e-9);
    const subset = await search([edited[0]!, edited[1]!]);
    assert.deepEqual(subset.map((row) => row.factId).sort(), [edited[0]!.id, edited[1]!.id].sort());
    assert.deepEqual(await search([]), []);
    assert.deepEqual(
      (await index.missing("hash-model", 256)).filter((row) => row.scope === scope),
      [],
    );
  },
);

test("capture folds near-duplicates into the stored fact and indexes what it wrote", { skip: !url }, async (t) => {
  const scope = `personal:near-${randomUUID()}`;
  const model = `near-${randomUUID()}`;
  const angle: Record<string, number> = {
    "Works on branch feature/sketch": 0,
    "Working on the feature/sketch branch": 10,
    "Prefers dark mode": 90,
    "Prefers dark mode in the web UI": 95,
    "Lives in Oakland": 180,
    "Uses Firefox": 270,
  };
  const vector = (text: string) => [Math.cos((angle[text]! * Math.PI) / 180), Math.sin((angle[text]! * Math.PI) / 180)];
  let up = true;
  const index = createPostgresVectorStore(url!);
  const client = new pg.Client({ connectionString: url! });
  await client.connect();
  t.after(async () => {
    await client.end();
    await index.close();
  });
  const errors: unknown[] = [];
  const base = createPostgresMemoryService(
    url!,
    createNearDuplicateFinder(
      async () => ({
        store: index,
        embedder: {
          id: model,
          async embed(texts) {
            if (!up) throw new Error("embedding provider down");
            return texts.map(vector);
          },
        },
      }),
      (error) => errors.push(error),
    ),
  );
  const texts = async () => (await base.facts!(scope)).map((fact) => fact.text);

  assert.equal(await base.capture(scope, ["Works on branch feature/sketch", "Lives in Oakland"], 1000), 2);
  const [branch, home] = await base.facts!(scope);
  assert.equal((await index.missing(model, 256)).filter((row) => row.scope === scope).length, 0);

  assert.equal(
    await base.capture(
      scope,
      ["Working on the feature/sketch branch", "Prefers dark mode", "Prefers dark mode in the web UI"],
      2000,
      undefined,
      { mode: "automatic", conversationScopeId: "channel:C9", sensitivity: "sensitive", inheritedFacts: [] },
    ),
    1,
  );
  const facts = await base.facts!(scope);
  assert.deepEqual(
    facts.map((fact) => fact.text),
    ["Working on the feature/sketch branch", "Lives in Oakland", "Prefers dark mode"],
  );
  assert.equal(facts[0]!.id, branch!.id);
  assert.equal(facts[0]!.createdAt, 1000);
  assert.equal(facts[0]!.updatedAt, 2000);
  assert.equal(facts[0]!.sensitivity, "sensitive");
  assert.deepEqual(facts[0]!.sources, [scope, "channel:C9"]);
  assert.deepEqual(facts[1], home);
  assert.deepEqual(
    (await storedVectors(client, scope, model)).map((row) => [row.fact_id, row.fact_hash]),
    facts.map((fact) => [fact.id, factHash(fact.text)]),
  );

  await base.delete!(scope, [home!.id]);
  assert.equal(await base.capture(scope, ["Lives in Oakland"], 3000), 1);

  up = false;
  assert.equal(await base.capture(scope, ["Prefers dark mode in the web UI", "Uses Firefox"], 4000), 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(await texts(), [
    "Working on the feature/sketch branch",
    "Prefers dark mode",
    "Lives in Oakland",
    "Prefers dark mode in the web UI",
    "Uses Firefox",
  ]);
});
