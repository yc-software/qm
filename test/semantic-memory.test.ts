import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSemanticMemory } from "../src/memory/semantic-memory.ts";
import { createNoopLeaderLease } from "../src/persistence/leader-lease.ts";
import { createSweeper } from "../src/util/sweeper.ts";
import { scoredMemoryIndex } from "./support/scored-memory-index.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createSemanticMemoryService, memoryRecallQuery } from "../src/memory/semantic-recall.ts";
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
  const index = scoredMemoryIndex(base, (text) => (/browser|verify|updated/i.test(text) ? 1 : 0));
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
  const { base, memory, calls } = await fixture(t);
  await base.capture("personal:a", ["browser preference"], AT);
  await recall(memory, "personal:a", { query: "verify" });
  calls.length = 0;
  assert.equal(await recall(memory, "personal:b", { query: "verify" }), "");
  assert.deepEqual(calls, []);
  await base.delete!("personal:a", ["1"]);
  assert.equal(await recall(memory, "personal:a", { query: "verify" }), "");
  assert.deepEqual(calls, []);
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

test("query failures fall back without rebuilding facts in recall", async (t) => {
  const { base, embedder, calls } = await fixture(t);
  await base.capture("personal:a", ["A fact"], AT);
  let errors = 0;
  const memory = createSemanticMemoryService(
    base,
    async () => embedder,
    {
      async search(input) {
        assert.deepEqual(input.vector, [1, 0]);
        throw new Error("Database query unavailable");
      },
    },
    { onError: () => errors++ },
  );
  assert.equal(await recall(memory, "personal:a", { query: "verify" }), "- (2026-10-01) A fact");
  assert.equal(errors, 1);
  assert.deepEqual(calls, [["verify"]]);
});

test("without Postgres semantic recall stays readable and never embeds facts", async (t) => {
  const { base, embedder, calls } = await fixture(t);
  await base.capture("personal:a", ["older fact", "newer fact"], AT);
  const { memory } = createSemanticMemory({
    notebook: base,
    databaseUrl: undefined,
    embeddingModel: async () => "test",
    resolveEmbedder: async () => embedder,
    leaderLease: createNoopLeaderLease(),
    createSweeper,
  });
  assert.match(await recall(memory, "personal:a", { query: "verify" }), /newer fact[\s\S]*older fact/);
  assert.deepEqual(calls, []);
});

test("moving the embedding gateway keeps the same model identity", async () => {
  const model = {
    kind: "embedding" as const,
    baseUrl: "https://gateway.invalid",
    id: "gateway/embed",
    name: "embed",
    provider: "qm:gateway",
  };
  const through = (url: string) =>
    createMemoryEmbedder(model, null, { url, apiKey: "k", apiKeyHeader: "x-k", models: { "gateway/embed": "embed" } });
  assert.equal(through("http://signer.one:8080/v1").id, through("http://signer.two:8080/v1").id);
});

test("fallback reloads current disclosed facts after an edit races the index query", async (t) => {
  const { base, embedder } = await fixture(t);
  await base.capture("personal:a", ["old private fact"], AT);
  const memory = createSemanticMemoryService(base, async () => embedder, {
    async search() {
      await base.edit!("personal:a", [{ id: "1", text: "current fact" }]);
      throw new Error("old hash no longer exists");
    },
  });
  const result = await memory.recall("personal:a", { query: "verify" });
  assert.match(result[0]!.text, /current fact/);
  assert.doesNotMatch(result[0]!.text, /old private/);
});

test("recall drops index matches for facts changed after the notebook was loaded", async (t) => {
  const { base, embedder } = await fixture(t);
  await base.capture("personal:a", ["browser preference", "browser history"], AT);
  const [first, second] = await base.facts!("personal:a");
  const memory = createSemanticMemoryService(base, async () => embedder, {
    async search() {
      return [
        { factId: first!.id, updatedAt: first!.updatedAt, score: 0.9 },
        { factId: second!.id, updatedAt: second!.updatedAt + 1, score: 0.8 },
      ];
    },
  });
  assert.equal(await recall(memory, "personal:a", { query: "verify" }), "- (2026-10-01) browser preference");
});
