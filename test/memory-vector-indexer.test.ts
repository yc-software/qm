import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryVectorIndexer } from "../src/memory/vector-indexer.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import type { MemoryVectorStore, MemoryVector } from "../src/memory/postgres-vector-store.ts";
import type { MemoryEmbedder } from "../src/model/embeddings.ts";

function fixture() {
  let now = 1000;
  const requests: Array<{ model: string; limit: number; dimensions?: number; afterId?: string }> = [];
  const writes: MemoryVector[][] = [];
  const failures: unknown[] = [];
  const prunes: string[] = [];
  const store: Pick<MemoryVectorStore, "missing" | "put" | "prune"> = {
    async missing(model, limit, dimensions, _signal, afterId) {
      requests.push({ model, limit, dimensions, afterId });
      return [
        {
          scope: "personal:a",
          factId: String(Number(afterId ?? 0) + 64),
          hash: "hash",
          text: afterId ? "good" : "bad",
        },
      ];
    },
    async put(rows) {
      writes.push([...rows]);
    },
    async prune(model, limit) {
      assert.equal(limit, 200);
      prunes.push(model);
      return 0;
    },
  };
  const embedder: MemoryEmbedder = {
    id: "model",
    async embed(texts) {
      return texts.map(() => [1, 0]);
    },
  };
  const indexer = createMemoryVectorIndexer({
    resolve: async () => ({ store, embedder }),
    leaderLease: createNoopLeaderLease(),
    now: () => now,
    onError: (error) => {
      failures.push(error);
    },
  });
  return {
    store,
    embedder,
    indexer,
    requests,
    writes,
    failures,
    prunes,
    advance: () => {
      now += 600001;
    },
  };
}

test("indexer advances the bounded cursor before a failed batch so later facts can progress", async () => {
  const f = fixture();
  f.embedder.embed = async (texts) => {
    if (texts.includes("bad")) throw new Error("poison batch");
    return texts.map(() => [1, 0]);
  };
  await f.indexer.tick();
  await f.indexer.tick();
  assert.deepEqual(f.requests, [
    { model: "model", limit: 64, dimensions: 2, afterId: undefined },
    { model: "model", limit: 64, dimensions: 2, afterId: "64" },
  ]);
  assert.equal(f.failures.length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]![0]!.factId, "128");
  assert.equal(f.prunes.length, 2);
});

test("indexer allows only one batch in flight even if a sweep overlaps", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.embedder.embed = async (texts) => {
    if (texts[0] === "bad") {
      entered();
      await gate;
    }
    return texts.map(() => [1, 0]);
  };
  const first = f.indexer.tick();
  await started;
  const second = f.indexer.tick();
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.writes.length, 1);
});

test("indexer resets its cursor on model and same-model dimension changes, and wraps at the end", async () => {
  const f = fixture();
  await f.indexer.tick();
  f.advance();
  f.embedder.embed = async (texts) => texts.map(() => [1, 0, 0]);
  await f.indexer.tick();
  f.embedder.id = "new-model";
  await f.indexer.tick();
  assert.ok(f.requests.every((request) => request.afterId === undefined));
  assert.deepEqual(
    f.requests.map((request) => request.dimensions),
    [2, 3, 3],
  );
  const missing = f.store.missing;
  f.store.missing = async (...args) => {
    await missing(...args);
    return [];
  };
  await f.indexer.tick();
  f.store.missing = missing;
  await f.indexer.tick();
  assert.equal(f.requests.at(-1)!.afterId, undefined);
});

test("indexer refuses malformed batches and never writes after losing its leader lease", async () => {
  const f = fixture();
  f.embedder.embed = async (texts) => (texts[0] === "bad" ? [[1, 0, 0]] : [[1, 0]]);
  await f.indexer.tick();
  assert.equal(f.writes.length, 0);
  assert.equal(f.failures.length, 1);
  let lose!: () => void;
  const lost = new Promise<void>((resolve) => {
    lose = resolve;
  });
  f.embedder.embed = async (texts) => {
    if (texts[0] === "bad") lose();
    return texts.map(() => [1, 0]);
  };
  const indexer = createMemoryVectorIndexer({
    resolve: async () => ({ store: f.store, embedder: f.embedder }),
    leaderLease: { hold: async (_key, fn) => fn(lost) },
    onError: (error) => {
      f.failures.push(error);
    },
  });
  await indexer.tick();
  assert.equal(f.writes.length, 0);
  assert.equal(f.failures.length, 2);
});

test("unconfigured indexing does not create a store or call an embedder", async () => {
  let resolutions = 0;
  const indexer = createMemoryVectorIndexer({
    resolve: async () => {
      resolutions++;
      return undefined;
    },
    leaderLease: createNoopLeaderLease(),
  });
  await indexer.tick();
  assert.equal(resolutions, 1);
});

test("fact embeddings stay bounded and dimension probes are cached for ten minutes", async () => {
  const f = fixture();
  const calls: string[][] = [];
  f.store.missing = async () => [{ scope: "personal:a", factId: "1", hash: "full-text-hash", text: "x".repeat(12000) }];
  f.embedder.embed = async (texts) => {
    calls.push(texts);
    return texts.map(() => [1, 0]);
  };
  await f.indexer.tick();
  await f.indexer.tick();
  assert.equal(calls.filter((texts) => texts[0] === "Memory index dimension probe.").length, 1);
  assert.equal(calls.filter((texts) => texts[0]?.length === 8000).length, 2);
  assert.equal(f.writes[0]![0]!.hash, "full-text-hash");
  f.advance();
  await f.indexer.tick();
  assert.equal(calls.filter((texts) => texts[0] === "Memory index dimension probe.").length, 2);
});

for (const operation of ["embed", "put"] as const) {
  test(`indexer reports both ${operation} and prune failures without masking either`, async () => {
    const f = fixture();
    const primary = new Error(`${operation} failed`);
    const cleanup = new Error("prune failed");
    if (operation === "embed") {
      f.embedder.embed = async (texts) => {
        if (texts[0] === "bad") throw primary;
        return texts.map(() => [1, 0]);
      };
    } else {
      f.store.put = async () => {
        throw primary;
      };
    }
    f.store.prune = async () => {
      throw cleanup;
    };
    await f.indexer.tick();
    assert.equal(f.failures.length, 2);
    assert.ok(f.failures.includes(primary));
    assert.ok(f.failures.includes(cleanup));
  });
}
