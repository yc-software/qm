import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import {
  createSemanticMemoryService,
  memoryRecallQuery,
  type MemoryVectorIndex,
} from "../src/memory/semantic-recall.ts";
import {
  createMemoryEmbedder,
  parseMemoryEmbeddingConfig,
  unitVector,
  type MemoryEmbedder,
} from "../src/memory/embeddings.ts";
import type { SessionEntry } from "../src/types.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "semantic-memory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = createMemoryService(createLocalWorkspaceStore(dir));
  const index = createMemoryMap<MemoryVectorIndex>();
  const calls: string[][] = [];
  const embedder: MemoryEmbedder = {
    id: "test-v1",
    async embed(texts) {
      calls.push(texts);
      return texts.map((text) => (/browser|verify|updated/i.test(text) ? [1, 0] : [0, 1]));
    },
  };
  return { base, index, calls, embedder, memory: createSemanticMemoryService(base, embedder, index) };
}

test("semantic recall selects an old match, respects budget, and leaves full grep independent", async (t) => {
  const { base, memory } = await fixture(t);
  await base.replace(
    "personal:a",
    "- browser preference\n" + Array.from({ length: 120 }, (_, i) => `- release ${i}: ${"x".repeat(70)}`).join("\n"),
  );
  assert.equal((await base.recall("personal:a")).includes("browser preference"), false);
  assert.equal(await memory.recall("personal:a", { query: "verify", maxChars: 40 }), "- browser preference");
  assert.equal(await memory.recall("personal:a", { query: "verify", maxChars: 0 }), "");
  assert.deepEqual(await memory.query("personal:a", "release 119"), ["release 119: " + "x".repeat(70)]);
  assert.deepEqual(await memory.query("personal:a", "BROWSER"), ["browser preference"]);
});

test("vectors persist across service instances; only changed facts are embedded", async (t) => {
  const { base, memory, index, embedder, calls } = await fixture(t);
  await base.replace("personal:a", "- browser preference\n- release note");
  await memory.recall("personal:a", { query: "verify" });
  calls.length = 0;
  const restarted = createSemanticMemoryService(base, embedder, index);
  await restarted.recall("personal:a", { query: "verify" });
  assert.deepEqual(calls, [["verify"]]);
  calls.length = 0;
  await base.replace("personal:a", "- browser preference\n- updated preference");
  await restarted.recall("personal:a", { query: "verify" });
  assert.deepEqual(calls, [["updated preference"], ["verify"]]);
  assert.equal(Object.keys((await index.get("personal:a"))!.vectors).length, 2);
});

test("empty/deleted notebooks and other scopes cannot return cached facts", async (t) => {
  const { base, memory, index, calls } = await fixture(t);
  await base.replace("personal:a", "- browser preference");
  await memory.recall("personal:a", { query: "verify" });
  calls.length = 0;
  assert.equal(await memory.recall("personal:b", { query: "verify" }), "");
  assert.deepEqual(calls, []);
  await base.replace("personal:a", "");
  assert.equal(await memory.recall("personal:a", { query: "verify" }), "");
  assert.equal(await index.get("personal:a"), null);
});

test("deletion while embedding does not reintroduce deleted facts into recall", async (t) => {
  const { base, index } = await fixture(t);
  await base.replace("personal:a", "- browser preference");
  const memory = createSemanticMemoryService(
    base,
    {
      id: "racy",
      async embed(texts) {
        await base.replace("personal:a", "");
        return texts.map(() => [1, 0]);
      },
    },
    index,
  );
  assert.equal(await memory.recall("personal:a", { query: "verify" }), "");
  assert.deepEqual((await index.get("personal:a"))!.vectors, {});
});

test("embedding outage falls back to whole bullets, without disabling grep or writes", async (t) => {
  const { base, index } = await fixture(t);
  let errors = 0;
  const memory = createSemanticMemoryService(
    base,
    {
      id: "down",
      async embed() {
        throw new Error("provider down");
      },
    },
    index,
    { onError: () => errors++ },
  );
  await memory.capture("personal:a", ["browser preference", "short"], Date.now());
  const fallback = await memory.recall("personal:a", { query: "verify", maxChars: 30 });
  assert.match(fallback, /short$/);
  assert.ok(fallback.length <= 30);
  assert.equal(errors, 1);
  assert.equal((await memory.query("personal:a", "browser")).length, 1);
});

test("partial backfills checkpoint and resume after provider failure", async (t) => {
  const { base, index, embedder, calls } = await fixture(t);
  await base.replace("personal:a", Array.from({ length: 70 }, (_, i) => `- browser ${i}`).join("\n"));
  let n = 0;
  const failing: MemoryEmbedder = {
    ...embedder,
    async embed(texts, signal) {
      if (++n === 2) throw new Error("timeout");
      return embedder.embed(texts, signal);
    },
  };
  await createSemanticMemoryService(base, failing, index).recall("personal:a", { query: "verify" });
  assert.equal(Object.keys((await index.get("personal:a"))!.vectors).length, 64);
  calls.length = 0;
  await createSemanticMemoryService(base, embedder, index).recall("personal:a", { query: "verify" });
  assert.equal(calls[0]!.length, 6);
});

test("model changes rebuild vectors rather than compare incompatible spaces", async (t) => {
  const { base, index, embedder, memory, calls } = await fixture(t);
  await base.replace("personal:a", "- browser preference");
  await memory.recall("personal:a", { query: "verify" });
  calls.length = 0;
  await createSemanticMemoryService(base, { ...embedder, id: "new-model" }, index).recall("personal:a", {
    query: "verify",
  });
  assert.deepEqual(calls, [["browser preference"], ["verify"]]);
});

test("recall query includes bounded dialogue, not tool payloads", () => {
  const entry = (type: string, text: string) => ({ type, payload: { text } }) as SessionEntry;
  const q = memoryRecallQuery("yes, do that", [
    entry("user", "Let's revise the portal timeout"),
    entry("assistant", "Extend the session"),
    entry("tool_result", "SECRET TOOL PAYLOAD"),
  ]);
  assert.match(q, /portal timeout/);
  assert.match(q, /yes, do that/);
  assert.doesNotMatch(q, /SECRET/);
  assert.ok(memoryRecallQuery("x".repeat(10000), [entry("user", "y".repeat(10000))]).length < 4100);
});

test("embedding config requires explicit endpoint/model/key and rejects credential URLs", () => {
  assert.equal(parseMemoryEmbeddingConfig({}), undefined);
  assert.throws(() => parseMemoryEmbeddingConfig({ MEMORY_EMBEDDING_MODEL: "m" }));
  assert.throws(() =>
    parseMemoryEmbeddingConfig({
      MEMORY_EMBEDDING_URL: "https://user:pass@example.com",
      MEMORY_EMBEDDING_MODEL: "m",
      MEMORY_EMBEDDING_API_KEY: "k",
    }),
  );
});

test("embedding client orders responses and normalizes vectors", async () => {
  const embedder = createMemoryEmbedder(
    { url: "https://example.com/embeddings", model: "m", apiKey: "k" },
    async (_url, opts) => {
      assert.equal(opts?.redirect, "error");
      assert.deepEqual(JSON.parse(String(opts?.body)).input, ["a", "b"]);
      return Response.json({
        data: [
          { index: 1, embedding: [0, 2] },
          { index: 0, embedding: [3, 0] },
        ],
      });
    },
  );
  assert.deepEqual(await embedder.embed(["a", "b"], AbortSignal.timeout(1000)), [
    [1, 0],
    [0, 1],
  ]);
  for (const v of [[], [0, 0], [NaN, 1], [Infinity, 1], ["1", 2]]) assert.throws(() => unitVector(v));
});

test("malformed responses and provider errors do not expose provider payloads", async () => {
  const config = { url: "https://example.com/embeddings", model: "m", apiKey: "k" };
  for (const data of [[{ index: 1, embedding: [1] }], [{ index: 0, embedding: [0] }], []]) {
    const embedder = createMemoryEmbedder(config, async () => Response.json({ data }));
    await assert.rejects(embedder.embed(["a"], AbortSignal.timeout(1000)));
  }
  const embedder = createMemoryEmbedder(config, async () => new Response("sensitive provider body", { status: 401 }));
  await assert.rejects(
    embedder.embed(["a"], AbortSignal.timeout(1000)),
    (e) => e instanceof Error && !e.message.includes("sensitive"),
  );
});

test("warm queries of the same notebook run concurrently, not behind one API request", async (t) => {
  const { base, index, memory } = await fixture(t);
  await base.replace("org:example", "- browser preference");
  await memory.recall("org:example", { query: "verify" });
  let active = 0,
    maximum = 0;
  const embedder: MemoryEmbedder = {
    id: "test-v1",
    async embed(texts) {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return texts.map(() => [1, 0]);
    },
  };
  const concurrent = createSemanticMemoryService(base, embedder, index);
  await Promise.all([
    concurrent.recall("org:example", { query: "verify" }),
    concurrent.recall("org:example", { query: "verify" }),
  ]);
  assert.equal(maximum, 2);
});

test("weak matches are omitted; an oversized fact doesn't displace smaller matches", async (t) => {
  const { base, memory } = await fixture(t);
  await base.replace("personal:a", "- release note");
  assert.equal(await memory.recall("personal:a", { query: "verify" }), "");
  await base.replace("personal:a", `- browser ${"x".repeat(100)}\n- browser short\n- browser second`);
  const result = await memory.recall("personal:a", { query: "verify", maxChars: 40 });
  assert.equal(result, "- browser short\n- browser second");
});
