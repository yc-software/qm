import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createSemanticMemoryService, type MemoryVector } from "../src/memory/semantic-recall.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import { recallAcrossScopes, renderRecall, searchAcrossScopes } from "../src/memory/cross-scope.ts";

const AT = Date.parse("2026-10-01T12:00:00Z");

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "cross-memory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = createLocalWorkspaceStore(dir);
  const base = createMemoryService(workspace);
  const calls: string[][] = [];
  const memory = createSemanticMemoryService(
    base,
    async () => ({
      id: "cross-test",
      async embed(texts) {
        calls.push(texts);
        return texts.map((text) => {
          const score = /^(Current|verify)/.test(text) ? 1 : Number(text.split(" ")[0]);
          return [score, Math.sqrt(1 - score * score)];
        });
      },
    }),
    createMemoryMap<MemoryVector>(),
  );
  return { base, memory, calls, workspace };
}

test("one ranking picks across notebooks and groups each under one heading", async (t) => {
  const { base, memory, calls } = await fixture(t);
  await base.capture("personal:a", ["0.7 local near tie", "0.1 irrelevant local"], AT);
  await base.capture("channel:b", ["0.72 remote near tie", "0.99 remote best"], AT);
  await base.capture("personal:forbidden", ["1 never authorized"], AT);
  const out = renderRecall(
    await recallAcrossScopes(memory, ["personal:a", "channel:b"], {
      query: "verify",
    }),
    new Map(),
  );
  assert.equal(
    out,
    "### channel:b\n- (2026-10-01) 0.99 remote best\n- (2026-10-01) 0.72 remote near tie\n\n### personal:a\n- (2026-10-01) 0.7 local near tie",
  );
  assert.equal(calls.filter((batch) => batch[0] === "verify").length, 1, "embed the query once, not per scope");
  assert.ok(calls.flat().every((text) => !text.includes("authorized")));
});

test("global packing counts source labels, skips oversized rows, deduplicates, and doesn't pad weak facts", async (t) => {
  const { base, memory } = await fixture(t);
  await base.capture("personal:a", [`0.9 ${"x".repeat(6100)}`, "0.8 duplicate", "0.1 weak"], AT);
  await base.capture("channel:b", ["0.8 duplicate", "0.85 remote high"], AT);
  const scopes = ["personal:a", "channel:b", "personal:a"];
  const out = renderRecall(
    await recallAcrossScopes(memory, scopes, {
      query: "verify",
      maxChars: 95,
    }),
    new Map(),
  );
  assert.ok(out.length <= 95);
  assert.match(out, /remote high/);
  assert.match(out, /duplicate/);
  assert.equal(out.match(/duplicate/g)?.length, 1);
  assert.doesNotMatch(out, /xxxxx|weak/);
  assert.equal(renderRecall(await recallAcrossScopes(memory, scopes, { query: "verify", maxChars: 0 }), new Map()), "");
});

test("provider routing preserves semantic scores and excludes recall-disabled routes", async (t) => {
  const { base, memory } = await fixture(t);
  await base.capture("personal:a", ["0.6 local"], AT);
  await base.capture("channel:b", ["0.99 remote"], AT);
  const routed = createRoutedMemoryService({
    providers: {
      default: memory,
      hidden: {
        ...base,
        recall: async () => {
          throw new Error("must not read");
        },
      },
    },
    routes: [
      { provider: "default", scopes: ["personal", "channel"] },
      { provider: "hidden", scopes: ["channel"], recall: false },
    ],
  });
  const out = renderRecall(
    await recallAcrossScopes(routed, ["personal:a", "channel:b"], {
      query: "verify",
    }),
    new Map(),
  );
  assert.ok(out.indexOf("remote") < out.indexOf("local"));
});

test("many large notebooks still share one 6000 character maximum", async (t) => {
  const { base, memory } = await fixture(t);
  const scopes = Array.from({ length: 25 }, (_, i) => `channel:${i}`);
  for (const scope of scopes)
    await base.capture(
      scope,
      Array.from({ length: 80 }, (_, i) => `0.8 ${scope} entry ${i} ${"x".repeat(70)}`),
      AT,
    );
  const out = renderRecall(await recallAcrossScopes(memory, scopes, { query: "verify", maxChars: 100000 }), new Map());
  assert.ok(out.length <= 6000);
  assert.ok(out.length > 5800);
});

test("grep interleaves notebooks and scope-targeted queries can reach later results", async (t) => {
  const { base } = await fixture(t);
  await base.capture(
    "personal:a",
    Array.from({ length: 50 }, (_, i) => `match local ${i}`),
    AT,
  );
  await base.capture("channel:b", ["match remote"], AT);
  assert.deepEqual(await searchAcrossScopes(base, ["personal:a", "channel:b"], "match", 2), [
    { scopeId: "personal:a", fact: "#1 (2026-10-01) match local 0" },
    { scopeId: "channel:b", fact: "#1 (2026-10-01) match remote" },
  ]);
  assert.deepEqual(await searchAcrossScopes(base, ["channel:b"], "match", 2), [
    { scopeId: "channel:b", fact: "#1 (2026-10-01) match remote" },
  ]);
});

test("candidate routing preserves fail-open/fail-closed providers without embedding their text", async (t) => {
  const { base, memory, calls } = await fixture(t);
  await base.capture("personal:a", ["0.8 local fact"], AT);
  const external = { ...base, recall: async () => [{ text: "External provider answer", score: 0.2 }] };
  const failing = {
    ...base,
    recall: async () => {
      throw new Error("provider failure");
    },
  };
  const providers = { default: memory, external, failing };
  const routes = [
    { provider: "default", scopes: ["personal:a"] },
    { provider: "external", scopes: ["channel:b"] },
    { provider: "failing", scopes: ["channel:c"], failOpen: true },
  ];
  const out = renderRecall(
    await recallAcrossScopes(
      createRoutedMemoryService({ providers, routes }),
      ["personal:a", "channel:b", "channel:c"],
      { query: "verify" },
    ),
    new Map(),
  );
  assert.match(out, /local fact/);
  assert.match(out, /External provider answer/);
  assert.ok(calls.flat().every((text) => !text.includes("External")));
  await assert.rejects(
    recallAcrossScopes(
      createRoutedMemoryService({ providers, routes: routes.map((route) => ({ ...route, failOpen: false })) }),
      ["channel:c"],
      { query: "verify" },
    ),
    /provider failure/,
  );
});

test("a recall-only provider's block gets one heading and fills the remaining budget", async (t) => {
  const { base } = await fixture(t);
  await base.capture(
    "personal:a",
    Array.from({ length: 60 }, (_, i) => `old fact ${i} ${"x".repeat(100)}`),
    AT,
  );
  const block = `EXTERNAL BLOCK ${"y".repeat(800)}`;
  const external = { ...base, recall: async () => [{ text: block, score: 0.2 }] };
  const routed = createRoutedMemoryService({
    providers: { default: base, external },
    routes: [
      { provider: "default", scopes: ["personal"] },
      { provider: "external", scopes: ["personal"], manage: false },
    ],
  });
  const out = renderRecall(await recallAcrossScopes(routed, ["personal:a"], { query: "x" }), new Map());
  assert.match(out, /\n### external\nEXTERNAL BLOCK/);
  assert.equal(out.match(/### /g)?.length, 2);
});

test("an external block that fills its maxChars is trimmed to the remaining budget, not dropped", async (t) => {
  const { base } = await fixture(t);
  await base.capture("personal:a", ["notebook fact"], AT);
  const external = {
    ...base,
    recall: async (_scope: string, context?: { maxChars?: number }) => [
      { text: "z".repeat(context?.maxChars ?? 6000), score: 0.2 },
    ],
  };
  const routed = createRoutedMemoryService({
    providers: { default: base, external },
    routes: [
      { provider: "default", scopes: ["personal"] },
      { provider: "external", scopes: ["personal"], manage: false },
    ],
  });
  const out = renderRecall(await recallAcrossScopes(routed, ["personal:a"], { query: "q", maxChars: 6000 }), new Map());
  assert.match(out, /zzzz/);
  assert.ok(out.length <= 6000);
});
