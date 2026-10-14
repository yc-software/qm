import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresVectorStore, type MemoryVectorStore } from "../src/memory/postgres-vector-store.ts";
import { createSemanticMemoryService } from "../src/memory/semantic-recall.ts";
import { factHash, type MemoryFact } from "../src/memory/facts.ts";
import { recallAcrossScopes } from "../src/memory/cross-scope.ts";
import { disclosedMemory } from "../src/memory/disclosure.ts";

const url = process.env.DATABASE_URL;
const requested = (facts: readonly MemoryFact[]) =>
  facts.map((fact) => ({ id: fact.id, hash: factHash(fact.text), at: fact.createdAt }));
const collect = async <T>(pages: AsyncIterable<T[]>) => {
  const out: T[] = [];
  for await (const page of pages) out.push(...page);
  return out;
};
const write = (
  store: MemoryVectorStore,
  scope: string,
  facts: readonly MemoryFact[],
  model = "test-v1",
  vector: (fact: MemoryFact) => number[] = () => [1, 0],
) =>
  store.put(facts.map((fact) => ({ scope, model, factId: fact.id, hash: factHash(fact.text), vector: vector(fact) })));

test(
  "Postgres native cosine persists across instances and rejects edited/deleted snapshots",
  { skip: !url },
  async (t) => {
    const scope = `personal:semantic-${randomUUID()}`;
    const base = createPostgresMemoryService(url!);
    const index = createPostgresVectorStore(url!);
    t.after(() => index.close());
    await base.capture(scope, ["original browser preference"], Date.now());
    const facts = await base.facts!(scope);
    await write(index, scope, facts);
    const search = () => index.search({ scope, model: "test-v1", vector: [1, 0], facts: requested(facts) });
    assert.equal((await collect(search()))[0]!.factId, facts[0]!.id);
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
    assert.deepEqual(await collect(search()), []);
    assert.match((await memory.recall(scope, { query: "verify" }))[0]!.text, /revised/);
    const revised = await base.facts!(scope);
    const unindexed = await collect(
      index.search({ scope, model: "test-v1", vector: [1, 0], facts: requested(revised) }),
    );
    assert.deepEqual(
      unindexed.map((row) => [row.factId, row.hash]),
      [[revised[0]!.id, factHash("revised browser preference")]],
    );
    assert.ok(Math.abs(unindexed[0]!.score - 0.2) < 1e-9);
    const lowered = await collect(
      index.search({ scope, model: "test-v1", vector: [1, 0], facts: requested(revised), minSimilarity: 0.1 }),
    );
    assert.ok(lowered.length === 1 && Math.abs(lowered[0]!.score - 0.1) < 1e-9);
    await write(index, scope, revised);
    assert.equal(
      (await collect(index.search({ scope, model: "test-v1", vector: [1, 0], facts: requested(revised) })))[0]!.score,
      1,
    );
    await base.delete!(scope, [facts[0]!.id]);
    assert.deepEqual(await collect(search()), []);
    assert.deepEqual(
      await collect(index.search({ scope, model: "test-v1", vector: [1, 0], facts: requested(revised) })),
      [],
    );
    assert.deepEqual(await memory.recall(scope, { query: "verify" }), []);
    assert.ok(!(await index.missing("test-v1", 256)).some((row) => row.factId === facts[0]!.id));
    await index.remove(scope, [facts[0]!.id]);
  },
);

test("native cosine uses exact bounded stable pages and excludes other scopes/models", { skip: !url }, async (t) => {
  const scope = `personal:pages-${randomUUID()}`;
  const base = createPostgresMemoryService(url!);
  const index = createPostgresVectorStore(url!);
  t.after(() => index.close());
  await base.capture(
    scope,
    Array.from({ length: 137 }, (_, i) => `same score ${i}`),
    1000,
  );
  const facts = await base.facts!(scope);
  await write(index, scope, facts, "rank-model", () => [3, 4]);
  await write(index, scope, facts, "other-model", () => [1, 0]);
  await write(index, "personal:other", facts, "rank-model", () => [1, 0]);
  const pages: string[][] = [];
  for await (const page of index.search({
    scope,
    model: "rank-model",
    vector: [2, 0],
    facts: requested(facts),
    pageSize: 7,
  })) {
    assert.ok(page.length <= 7);
    assert.ok(page.every((row) => Math.abs(row.score - 0.6) < 1e-6));
    pages.push(page.map((row) => row.factId));
  }
  assert.ok(pages.length > 1);
  assert.deepEqual(pages.flat(), facts.map((fact) => fact.id).sort());
  const weak = await collect(
    index.search({ scope, model: "rank-model", vector: [1, 0], facts: requested(facts), minSimilarity: 0.9 }),
  );
  assert.deepEqual(weak, []);
});

test(
  "3072-dimensional vectors work and model or dimension drift falls back without embedding facts",
  { skip: !url },
  async (t) => {
    const scope = `personal:width-${randomUUID()}`;
    const base = createPostgresMemoryService(url!);
    const index = createPostgresVectorStore(url!);
    t.after(() => index.close());
    await base.capture(scope, ["real embedding width"], 1000);
    const facts = await base.facts!(scope);
    const wide = Array.from({ length: 3072 }, (_, i) => (i === 0 ? 1 : 0));
    await write(index, scope, facts, "wide-model", () => wide);
    assert.equal(
      (await collect(index.search({ scope, model: "wide-model", vector: wide, facts: requested(facts) })))[0]!.score,
      1,
    );
    const unindexedScore = async (model: string, vector: number[]) => {
      const rows = await collect(index.search({ scope, model, vector, facts: requested(facts) }));
      return rows.length === 1 && Math.abs(rows[0]!.score - 0.2) < 1e-9;
    };
    assert.ok(await unindexedScore("wide-model", [1, 0]));
    assert.ok(await unindexedScore("new-model", wide));
    assert.ok(
      (await index.missing("wide-model", 256, 2, undefined, String(BigInt(facts[0]!.id) - 1n))).some(
        (row) => row.factId === facts[0]!.id,
      ),
    );
    await write(index, scope, facts, "wide-model", () => [1, 0]);
    assert.equal(
      (await collect(index.search({ scope, model: "wide-model", vector: [1, 0], facts: requested(facts) })))[0]!.score,
      1,
    );
    await assert.rejects(
      index.put([{ scope, model: "wide-model", factId: facts[0]!.id, hash: factHash(facts[0]!.text), vector: [0, 0] }]),
      /Invalid memory embedding/,
    );
  },
);

test(
  "disclosure filters hidden leaders before ranking and packing finds late short candidates",
  { skip: !url },
  async (t) => {
    const actor = { id: `actor-${randomUUID()}`, type: "internal" as const };
    const scope = `personal:${actor.id}`;
    const base = createPostgresMemoryService(url!);
    const index = createPostgresVectorStore(url!);
    t.after(() => index.close());
    await base.capture(
      scope,
      Array.from({ length: 130 }, (_, i) => `hidden ${i}`),
      1000,
      undefined,
      { mode: "explicit", sensitivity: "restricted", inheritedFacts: [] },
    );
    await base.capture(
      scope,
      [...Array.from({ length: 130 }, (_, i) => `large ${i} ${"x".repeat(500)}`), "visible small"],
      1000,
      undefined,
      { mode: "explicit", sensitivity: "ordinary", inheritedFacts: [] },
    );
    await write(index, scope, await base.facts!(scope), "test-v1", (fact) =>
      fact.text.startsWith("hidden") ? [1, 0] : [0.8, 0.6],
    );
    const memory = createSemanticMemoryService(
      base,
      async () => ({ id: "test-v1", embed: async () => [[1, 0]] }),
      index,
    );
    const view = disclosedMemory(memory, {
      actor,
      targetScope: "group:room",
      nativeScopes: ["group:room"],
      audience: [actor, { id: "other", type: "internal" }],
      open: true,
      config: { resolveSharingPostureDurable: async () => "open" },
      currentScopeMembers: async () => [actor, { id: "other", type: "internal" }],
    });
    const result = await recallAcrossScopes(view, [scope], { query: "query", maxChars: 100 });
    assert.equal(result.length, 1);
    assert.match(result[0]!.text, /visible small/);
  },
);

test("search cancellation and server statement timeout release locked queries", { skip: !url }, async (t) => {
  const scope = `personal:timeout-${randomUUID()}`;
  const base = createPostgresMemoryService(url!);
  const index = createPostgresVectorStore(url!);
  t.after(() => index.close());
  await base.capture(scope, ["locked fact"], 1000);
  const facts = await base.facts!(scope);
  await write(index, scope, facts);
  const client = new pg.Client({ connectionString: url! });
  await client.connect();
  t.after(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });
  await client.query("BEGIN");
  await client.query("LOCK memory_fact_vectors IN ACCESS EXCLUSIVE MODE");
  const started = performance.now();
  await assert.rejects(
    collect(
      index.search({
        scope,
        model: "test-v1",
        vector: [1, 0],
        facts: requested(facts),
        signal: AbortSignal.timeout(100),
      }),
    ),
  );
  assert.ok(performance.now() - started < 3000);
  await assert.rejects(
    collect(index.search({ scope, model: "test-v1", vector: [1, 0], facts: requested(facts) })),
    (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "57014",
  );
  await client.query("ROLLBACK");
  assert.equal(
    (await collect(index.search({ scope, model: "test-v1", vector: [1, 0], facts: requested(facts) }))).length,
    1,
  );
});

const storedVectors = async (client: pg.Client, scope: string, model: string) =>
  (
    await client.query(
      `SELECT fact_id, fact_hash, dimensions, embedding::text AS embedding FROM memory_fact_vectors
       WHERE scope_id = $1 AND model = $2 ORDER BY fact_id::bigint`,
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

test("missing pages forward by numeric fact id cursor", { skip: !url }, async (t) => {
  const scope = `personal:cursor-${randomUUID()}`;
  const model = `cursor-${randomUUID()}`;
  const base = createPostgresMemoryService(url!);
  const index = createPostgresVectorStore(url!);
  t.after(() => index.close());
  await base.capture(scope, ["cursor 0", "cursor 1", "cursor 2", "cursor 3", "cursor 4"], 1000);
  const facts = await base.facts!(scope);
  const ids = facts.map((fact) => fact.id);
  await write(index, scope, [facts[1]!], model);
  const start = String(BigInt(ids[0]!) - 1n);
  const seen: string[] = [];
  let afterId: string | undefined = start;
  while (!seen.includes(ids.at(-1)!)) {
    const page = await index.missing(model, 2, 2, undefined, afterId);
    assert.ok(page.length >= 1 && page.length <= 2);
    assert.ok(page.every((row) => BigInt(row.factId) > BigInt(afterId!)));
    seen.push(...page.filter((row) => row.scope === scope).map((row) => row.factId));
    afterId = page.at(-1)!.factId;
  }
  assert.deepEqual(seen, [ids[0], ids[2], ids[3], ids[4]]);
  assert.ok(!(await index.missing(model, 256, 2, undefined, ids.at(-1))).some((row) => row.scope === scope));
  await assert.rejects(index.missing(model, 1, 2, undefined, "1 OR 1=1"), /Invalid memory fact cursor/);
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

test("legacy vectors copy resumably to every live matching fact without overwriting", { skip: !url }, async (t) => {
  const scope = `personal:legacy-${randomUUID()}`;
  const model = `legacy-${randomUUID()}`;
  const base = createPostgresMemoryService(url!);
  const client = new pg.Client({ connectionString: url! });
  await client.connect();
  let index = createPostgresVectorStore(url!);
  t.after(async () => {
    await client.query("DELETE FROM memory_vectors WHERE json->>'scope' = $1", [scope]);
    await client.end();
    await index.close();
  });
  await base.capture(scope, ["legacy beta", "legacy gamma", "legacy delta", "legacy gone"], 1000);
  await client.query(
    `INSERT INTO memory_facts(scope_id, text, sensitivity, source_unknown, created_at, updated_at)
     SELECT $1, 'legacy alpha', 'unknown', true, 1000, 1000 FROM generate_series(1, 2)`,
    [scope],
  );
  const facts = await base.facts!(scope);
  const byText = (text: string) => facts.filter((fact) => fact.text === text).map((fact) => fact.id);
  await base.delete!(scope, byText("legacy gone"));
  const beta = facts.find((fact) => fact.text === "legacy beta")!;
  await write(index, scope, [beta], model);
  await client.query("CREATE TABLE IF NOT EXISTS memory_vectors (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
  const legacy = [
    { text: "legacy alpha", vector: [3, 4] },
    { text: "legacy beta", vector: [0, 2] },
    { text: "legacy gamma", vector: [0, 0] },
    { text: "legacy delta", vector: [1, 0, 0] },
    { text: "legacy gone", vector: [1, 0] },
    { text: "legacy nobody", vector: [1, 0] },
    { text: "legacy gamma", vector: ["1", 0], model: `${model}-other` },
  ];
  for (const row of legacy) {
    const value = { scope, model: row.model ?? model, hash: factHash(row.text), vector: row.vector };
    await client.query("INSERT INTO memory_vectors(id, json) VALUES ($1, $2)", [
      JSON.stringify([value.scope, value.model, value.hash]),
      JSON.stringify(value),
    ]);
  }
  await client.query("INSERT INTO memory_vectors(id, json) VALUES ($1, $2)", [
    JSON.stringify([scope, model, "invalid"]),
    JSON.stringify({ scope, model, hash: factHash("legacy delta"), vector: [1, "x"] }),
  ]);
  const total = Number((await client.query("SELECT count(*) FROM memory_vectors")).rows[0].count);
  assert.deepEqual(await index.migrateLegacy(model, 2, 1), { processed: 1, done: false });
  const progress = await client.query(
    "SELECT cursor, done FROM memory_vector_legacy_progress WHERE model = $1 AND dimensions = 2",
    [model],
  );
  assert.equal(progress.rows[0].done, false);
  assert.ok(progress.rows[0].cursor);
  await index.close();
  index = createPostgresVectorStore(url!);
  let processed = 1;
  for (;;) {
    const step = await index.migrateLegacy(model, 2, 3);
    assert.ok(step.processed <= 3);
    processed += step.processed;
    if (step.done) break;
  }
  assert.equal(processed, total);
  assert.deepEqual(await index.migrateLegacy(model, 2, 3), { processed: 0, done: true });
  const rows = await storedVectors(client, scope, model);
  assert.deepEqual(
    rows.map((row) => row.fact_id),
    [beta.id, ...byText("legacy alpha")].sort((a, b) => Number(BigInt(a) - BigInt(b))),
  );
  assert.equal(rows.find((row) => row.fact_id === beta.id)!.embedding, "[1,0]");
  for (const row of rows.filter((row) => row.fact_id !== beta.id)) {
    assert.equal(row.fact_hash, factHash("legacy alpha"));
    assert.equal(row.embedding, "[0.6,0.8]");
  }
  assert.equal(
    Number(
      (await client.query("SELECT count(*) FROM memory_vectors WHERE json->>'scope' = $1", [scope])).rows[0].count,
    ),
    legacy.length + 1,
  );
  const [search] = await collect(
    index.search({
      scope,
      model,
      vector: [3, 4],
      facts: facts
        .filter((fact) => fact.text === "legacy alpha")
        .map((fact) => ({ id: fact.id, hash: factHash(fact.text), at: fact.createdAt })),
    }),
  );
  assert.ok(Math.abs(search!.score - 1) < 1e-6);
});
