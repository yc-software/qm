import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createSemanticMemoryService, memoryRecallQuery, type MemoryVector } from "../src/memory/semantic-recall.ts";
import { createMemoryEmbedder, unitVector, type MemoryEmbedder } from "../src/model/embeddings.ts";
import { recallAcrossScopes, renderRecall } from "../src/memory/cross-scope.ts";
import type { MemoryRecallContext, MemoryService } from "../src/memory/memory-service.ts";

const recall = async (memory: MemoryService, scope: string, context: MemoryRecallContext = {}) =>
  (await recallAcrossScopes(memory, [scope], context)).map((fact) => fact.text).join("\n");
import type { SessionEntry } from "../src/types.ts";

const AT = Date.parse("2026-10-01T12:00:00Z");

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "semantic-memory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = createMemoryService(createLocalWorkspaceStore(dir));
  const index = createMemoryMap<MemoryVector>();
  const calls: string[][] = [];
  const embedder: MemoryEmbedder = {
    id: "test-v1",
    async embed(texts) {
      calls.push(texts);
      return texts.map((text) => (/browser|verify|updated/i.test(text) ? [1, 0] : [0, 1]));
    },
  };
  return { base, index, calls, embedder, memory: createSemanticMemoryService(base, async () => embedder, index) };
}

test("semantic recall selects an old match, respects budget, and leaves full grep independent", async (t) => {
  const { base, memory } = await fixture(t);
  await base.capture(
    "personal:a",
    ["browser preference", ...Array.from({ length: 120 }, (_, i) => `release ${i}: ${"x".repeat(70)}`)],
    AT,
  );

  assert.equal(
    await recall(memory, "personal:a", { query: "verify", maxChars: 60 }),
    "- (2026-10-01) browser preference",
  );
  assert.equal(await recall(memory, "personal:a", { query: "verify", maxChars: 0 }), "");
  assert.deepEqual(await memory.query("personal:a", "release 119"), [
    "#121 (2026-10-01) release 119: " + "x".repeat(70),
  ]);
  assert.deepEqual(await memory.query("personal:a", "BROWSER"), ["#1 (2026-10-01) browser preference"]);
});

test("empty/deleted notebooks and other scopes cannot return cached facts", async (t) => {
  const { base, memory, index, calls } = await fixture(t);
  await base.capture("personal:a", ["browser preference"], AT);
  await recall(memory, "personal:a", { query: "verify" });
  calls.length = 0;
  assert.equal(await recall(memory, "personal:b", { query: "verify" }), "");
  assert.deepEqual(calls, []);
  await base.delete!("personal:a", ["1"]);
  assert.equal(await recall(memory, "personal:a", { query: "verify" }), "");
  assert.deepEqual(await index.all(), []);
});

test("embedding outage falls back to whole bullets, without disabling grep or writes", async (t) => {
  const { base, index } = await fixture(t);
  let errors = 0;
  const memory = createSemanticMemoryService(
    base,
    async () => ({
      id: "down",
      async embed() {
        throw new Error("provider down");
      },
    }),
    index,
    { onError: () => errors++ },
  );
  await memory.capture("personal:a", ["browser preference", "short"], Date.now());
  const fallback = await recall(memory, "personal:a", { query: "verify", maxChars: 50 });
  assert.match(fallback, /short$/);
  assert.ok(fallback.length <= 50);
  assert.equal(errors, 1);
  assert.equal((await memory.query("personal:a", "browser")).length, 1);
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

test("embedding client orders responses and normalizes vectors", async () => {
  const embedder = createMemoryEmbedder(
    { kind: "embedding" as const, baseUrl: "https://example.com", id: "m", name: "m", provider: "openai" },
    "k",
    undefined,
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
  const config = { kind: "embedding" as const, baseUrl: "https://example.com", id: "m", name: "m", provider: "openai" };
  for (const data of [[{ index: 1, embedding: [1] }], [{ index: 0, embedding: [0] }], []]) {
    const embedder = createMemoryEmbedder(config, "k", undefined, async () => Response.json({ data }));
    await assert.rejects(embedder.embed(["a"], AbortSignal.timeout(1000)));
  }
  const embedder = createMemoryEmbedder(
    config,
    "k",
    undefined,
    async () => new Response("sensitive provider body", { status: 401 }),
  );
  await assert.rejects(
    embedder.embed(["a"], AbortSignal.timeout(1000)),
    (e) => e instanceof Error && !e.message.includes("sensitive"),
  );
});

test("weak matches are omitted; an oversized fact doesn't displace smaller matches", async (t) => {
  const { base, memory } = await fixture(t);
  await base.capture("personal:a", ["release note"], AT);
  assert.equal(await recall(memory, "personal:a", { query: "verify" }), "");
  await base.delete!("personal:a", ["1"]);
  await base.capture("personal:a", [`browser ${"x".repeat(100)}`, "browser short", "browser second"], AT);
  const result = await recall(memory, "personal:a", { query: "verify", maxChars: 90 });
  assert.equal(result, "- (2026-10-01) browser short\n- (2026-10-01) browser second");
});

test("without an embedding model, prompt recall takes the newest facts across notebooks within the cap", async (t) => {
  const { base, index } = await fixture(t);
  const memory = createSemanticMemoryService(base, async () => undefined, index);
  const on = (date: string) => Date.parse(`${date}T12:00:00Z`);
  await base.capture(
    "personal:a",
    Array.from({ length: 80 }, (_, i) => `old ${i} ${"x".repeat(80)}`),
    on("2026-01-01"),
  );
  await base.capture("personal:a", ["NEWEST_LOCAL"], on("2026-10-01"));
  await base.capture("channel:b", ["OLD_ROOM"], on("2025-02-01"));
  await base.capture("channel:b", ["NEW_ROOM"], on("2026-09-01"));
  const out = renderRecall(
    await recallAcrossScopes(memory, ["personal:a", "channel:b"], { query: "anything" }),
    new Map(),
  );
  assert.ok(out.length <= 6000);
  assert.match(out, /NEWEST_LOCAL/);
  assert.match(out, /### channel:b\n- \(2026-09-01\) NEW_ROOM/);
  assert.doesNotMatch(out, /old 0 /);
});

test("a provider vector-width change falls back to recency and rebuilds the index", async (t) => {
  const { base, index } = await fixture(t);
  let width = 2;
  const embedder: MemoryEmbedder = {
    id: "same-model",
    embed: async (texts) => texts.map(() => Array.from({ length: width }, () => 1)),
  };
  const memory = createSemanticMemoryService(base, async () => embedder, index);
  await base.capture("personal:a", ["A fact"], AT);
  await recall(memory, "personal:a", { query: "fact" });
  width = 3;
  assert.equal(await recall(memory, "personal:a", { query: "fact" }), "- (2026-10-01) A fact");
  await recall(memory, "personal:a", { query: "fact" });
  assert.deepEqual(
    (await index.all()).map((row) => row.vector.length),
    [3],
  );
});

test("moving the embedding gateway to another URL keeps the vector index", async (t) => {
  const { base, index } = await fixture(t);
  await base.capture("personal:a", ["browser preference", "release note"], AT);
  const model = {
    kind: "embedding" as const,
    baseUrl: "https://gateway.invalid",
    id: "gateway/embed",
    name: "embed",
    provider: "qm:gateway",
  };
  const embedded: string[] = [];
  const through = (url: string) => {
    const transport = { url, apiKey: "k", apiKeyHeader: "x-k", models: { "gateway/embed": "embed" } };
    const embedder = createMemoryEmbedder(model, null, transport, async (_url, init) => {
      const input = JSON.parse(String(init?.body)).input as string[];
      embedded.push(...input);
      return Response.json({
        data: input.map((text, i) => ({ index: i, embedding: /browser|verify/i.test(text) ? [1, 0] : [0, 1] })),
      });
    });
    return createSemanticMemoryService(base, async () => embedder, index);
  };
  assert.equal(
    await recall(through("http://signer.one:8080/v1"), "personal:a", { query: "verify" }),
    "- (2026-10-01) browser preference",
  );
  const rows = await index.all();
  embedded.length = 0;
  assert.equal(
    await recall(through("http://signer.two:8080/v1"), "personal:a", { query: "verify" }),
    "- (2026-10-01) browser preference",
  );
  assert.deepEqual(embedded, ["verify"]);
  assert.deepEqual(await index.all(), rows);
});

test("re-indexing a large notebook for a new model keeps index writes bounded", async (t) => {
  const { base, index } = await fixture(t);
  await base.capture(
    "personal:a",
    Array.from({ length: 40 }, (_, i) => `fact ${i}`),
    AT,
  );
  let inFlight = 0;
  let peak = 0;
  const track = async (write: () => Promise<void>) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      await write();
    } finally {
      inFlight--;
    }
  };
  const tracked = {
    ...index,
    put: (id: string, value: MemoryVector) => track(() => index.put(id, value)),
    delete: (id: string) => track(() => index.delete(id)),
  };
  const model = (id: string): MemoryEmbedder => ({ id, embed: async (texts) => texts.map(() => [1, 0]) });
  for (const id of ["old-model", "new-model"])
    await recall(
      createSemanticMemoryService(base, async () => model(id), tracked),
      "personal:a",
      { query: "fact" },
    );
  assert.ok(peak <= 4, `peak concurrent index writes ${peak}`);
  const rows = await index.all();
  assert.equal(rows.length, 40);
  assert.ok(rows.every((row) => row.model === "new-model"));
});
