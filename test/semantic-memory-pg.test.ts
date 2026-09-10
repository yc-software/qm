import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createSemanticMemoryService, type MemoryVectorIndex } from "../src/memory/semantic-recall.ts";
import type { MemoryEmbedder } from "../src/memory/embeddings.ts";

const url = process.env.DATABASE_URL;
test("Postgres persists vectors across instances and reconciles CAS edits/restores", { skip: !url }, async () => {
  const scope = `personal:semantic-${randomUUID()}`;
  const notebook = createPostgresMemoryService(url!);
  const index = createPostgresMapFactory(url!).map<MemoryVectorIndex>("memory_vectors");
  const calls: string[][] = [];
  const embedder: MemoryEmbedder = {
    id: "test-v1",
    async embed(texts) {
      calls.push(texts);
      return texts.map(() => [1, 0]);
    },
  };
  const first = createSemanticMemoryService(notebook, embedder, index);
  await first.capture(scope, ["original browser preference"], Date.now());
  await first.recall(scope, { query: "verify" });
  const original = await first.readHead!(scope);
  const reopened = createSemanticMemoryService(
    createPostgresMemoryService(url!),
    embedder,
    createPostgresMapFactory(url!).map<MemoryVectorIndex>("memory_vectors"),
  );
  calls.length = 0;
  assert.match(await reopened.recall(scope, { query: "verify" }), /original/);
  assert.deepEqual(calls, [["verify"]]);
  assert.equal(await reopened.replaceIfRevision!(scope, "- revised browser preference", original.revision), true);
  assert.equal(await reopened.replaceIfRevision!(scope, "- should not win", original.revision), false);
  assert.equal(await reopened.recall(scope, { query: "verify" }), "- revised browser preference");
  const revised = await reopened.readHead!(scope);
  assert.equal(await reopened.restore!(scope, original.revision, revised.revision), true);
  assert.match(await reopened.recall(scope, { query: "verify" }), /original/);
  assert.equal(Object.keys((await index.get(scope))!.vectors).length, 1);
  await reopened.replace(scope, "");
  assert.equal(await reopened.recall(scope, { query: "verify" }), "");
  assert.equal(await index.get(scope), null);
});
