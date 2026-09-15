import { createScratchPromote } from "../src/memory/strategies/scratch-promote.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createSemanticMemoryService, type MemoryVectorIndex } from "../src/memory/semantic-recall.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import { recallAcrossScopes, searchAcrossScopes } from "../src/memory/cross-scope.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "cross-memory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = createLocalWorkspaceStore(dir);
  const base = createMemoryService(workspace);
  const calls: string[][] = [];
  const memory = createSemanticMemoryService(
    base,
    {
      id: "cross-test",
      async embed(texts) {
        calls.push(texts);
        return texts.map((text) => {
          const score = /^(Current|verify)/.test(text) ? 1 : Number(text.split(" ")[0]);
          return [score, Math.sqrt(1 - score * score)];
        });
      },
    },
    createMemoryMap<MemoryVectorIndex>(),
  );
  return { base, memory, calls, workspace };
}

test("one ranking combines scopes, slightly favors local ties, but stronger remote facts win", async (t) => {
  const { base, memory, calls } = await fixture(t);
  await base.replace("personal:a", "- 0.7 local near tie\n- 0.1 irrelevant local");
  await base.replace("channel:b", "- 0.72 remote near tie\n- 0.99 remote best");
  await base.replace("personal:forbidden", "- 1 never authorized");
  const out = await recallAcrossScopes(memory, ["personal:a", "channel:b"], {
    query: "verify",
    conversationScopeId: "personal:a",
  });
  assert.ok(out.indexOf("remote best") < out.indexOf("local near tie"));
  assert.ok(out.indexOf("local near tie") < out.indexOf("remote near tie"));
  assert.doesNotMatch(out, /irrelevant|authorized/);
  assert.match(out, /### channel:b/);
  assert.match(out, /### personal:a/);
  assert.equal(calls.filter((batch) => batch[0] === "verify").length, 1, "embed the query once, not per scope");
  assert.ok(calls.flat().every((text) => !text.includes("authorized")));
});

test("global packing counts source labels, skips oversized rows, deduplicates, and doesn't pad weak facts", async (t) => {
  const { base, memory } = await fixture(t);
  await base.replace("personal:a", `- 0.9 ${"x".repeat(6100)}\n- 0.8 duplicate\n- 0.1 weak`);
  await base.replace("channel:b", "- 0.8 duplicate\n- 0.85 remote high");
  const scopes = ["personal:a", "channel:b", "personal:a"];
  const out = await recallAcrossScopes(memory, scopes, {
    query: "verify",
    conversationScopeId: "personal:a",
    maxChars: 95,
  });
  assert.ok(out.length <= 95);
  assert.match(out, /remote high/);
  assert.match(out, /duplicate/);
  assert.equal(out.match(/duplicate/g)?.length, 1);
  assert.doesNotMatch(out, /xxxxx|weak/);
  assert.equal(await recallAcrossScopes(memory, scopes, { query: "verify", maxChars: 0 }), "");
});

test("provider routing preserves semantic scores and excludes recall-disabled routes", async (t) => {
  const { base, memory } = await fixture(t);
  await base.replace("personal:a", "- 0.6 local");
  await base.replace("channel:b", "- 0.99 remote");
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
  const out = await recallAcrossScopes(routed, ["personal:a", "channel:b"], {
    query: "verify",
    conversationScopeId: "personal:a",
  });
  assert.ok(out.indexOf("remote") < out.indexOf("local"));
});

test("many large notebooks still share one 6000 character maximum", async (t) => {
  const { base, memory } = await fixture(t);
  const scopes = Array.from({ length: 25 }, (_, i) => `channel:${i}`);
  for (const scope of scopes)
    await base.replace(
      scope,
      Array.from({ length: 80 }, (_, i) => `- 0.8 ${scope} entry ${i} ${"x".repeat(70)}`).join("\n"),
    );
  const out = await recallAcrossScopes(memory, scopes, { query: "verify", maxChars: 100000 });
  assert.ok(out.length <= 6000);
  assert.ok(out.length > 5800);
});

test("grep interleaves notebooks and scope-targeted queries can reach later results", async (t) => {
  const { base } = await fixture(t);
  await base.replace("personal:a", Array.from({ length: 50 }, (_, i) => `- match local ${i}`).join("\n"));
  await base.replace("channel:b", "- match remote");
  assert.deepEqual(await searchAcrossScopes(base, ["personal:a", "channel:b"], "match", 2), [
    { scopeId: "personal:a", fact: "match local 0" },
    { scopeId: "channel:b", fact: "match remote" },
  ]);
  assert.deepEqual(await searchAcrossScopes(base, ["channel:b"], "match", 2), [
    { scopeId: "channel:b", fact: "match remote" },
  ]);
});

test("candidate routing preserves fail-open/fail-closed providers without embedding their text", async (t) => {
  const { base, memory, calls } = await fixture(t);
  await base.replace("personal:a", "- 0.8 local fact");
  const external = { ...base, recall: async () => "External provider answer" };
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
  const out = await recallAcrossScopes(
    createRoutedMemoryService({ providers, routes }),
    ["personal:a", "channel:b", "channel:c"],
    { query: "verify", conversationScopeId: "personal:a" },
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

test("scratch strategy retains recent logs in combined recall without leaking bookkeeping markers", async (t) => {
  const { base, workspace } = await fixture(t);
  await base.replace("personal:a", "- durable fact\n<!-- captures-since-promote: 1 -->");
  const { memory } = createScratchPromote({ memory: base, workspace, harness: {} as never, consolidateAfter: 20 });
  await memory.capture("personal:a", ["recent scratch fact"], Date.now());
  const out = await recallAcrossScopes(memory, ["personal:a"], { query: "verify" });
  assert.match(out, /durable fact/);
  assert.match(out, /recent scratch fact/);
  assert.doesNotMatch(out, /captures-since-promote/);
  assert.ok(out.length <= 6000);
});
