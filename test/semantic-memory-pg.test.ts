import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createSemanticMemoryService, type MemoryVector } from "../src/memory/semantic-recall.ts";
import type { MemoryEmbedder } from "../src/model/embeddings.ts";
import { recallAcrossScopes } from "../src/memory/cross-scope.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";

const recall = async (memory: MemoryService, scope: string, context = {}) =>
  (await recallAcrossScopes(memory, [scope], context)).map((fact) => fact.text).join("\n");

const url = process.env.DATABASE_URL;
test("Postgres persists vectors across instances and follows fact edits and deletes", { skip: !url }, async () => {
  const scope = `personal:semantic-${randomUUID()}`;
  const index = createPostgresMapFactory(url!).map<MemoryVector>("memory_vectors", ["scope"]);
  const calls: string[][] = [];
  const embedder: MemoryEmbedder = {
    id: "test-v1",
    async embed(texts) {
      calls.push(texts);
      return texts.map(() => [1, 0]);
    },
  };
  const first = createSemanticMemoryService(createPostgresMemoryService(url!), async () => embedder, index);
  await first.capture(scope, ["original browser preference"], Date.now());
  await recall(first, scope, { query: "verify" });
  const reopened = createSemanticMemoryService(
    createPostgresMemoryService(url!),
    async () => embedder,
    createPostgresMapFactory(url!).map<MemoryVector>("memory_vectors", ["scope"]),
  );
  calls.length = 0;
  assert.match(await recall(reopened, scope, { query: "verify" }), /original/);
  assert.deepEqual(calls, [["verify"]]);
  const [fact] = await reopened.facts!(scope);
  await reopened.edit!(scope, [{ id: fact!.id, text: "revised browser preference" }]);
  assert.match(
    await recall(reopened, scope, { query: "verify" }),
    /^- \(\d{4}-\d\d-\d\d\) revised browser preference$/,
  );
  assert.equal((await index.select({ where: { field: "scope", anyOfFold: [scope] } })).length, 1);
  await reopened.delete!(scope, [fact!.id]);
  assert.equal(await recall(reopened, scope, { query: "verify" }), "");
  assert.deepEqual(await index.select({ where: { field: "scope", anyOfFold: [scope] } }), []);
});
