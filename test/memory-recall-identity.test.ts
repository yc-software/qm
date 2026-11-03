import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpMemoryProvider } from "../src/memory/mcp-memory-provider.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createRoutedMemoryService, type MemoryProviderRoute } from "../src/memory/provider-router.ts";
import { recallAcrossScopes, renderRecall, searchAcrossScopes } from "../src/memory/cross-scope.ts";
import { memoryRecallDelta, shownFacts } from "../src/memory/recall-delta.ts";
import type { McpClient } from "../src/mcp/mcp-client.ts";
import type { MemoryProviderOutcome, MemoryService } from "../src/memory/memory-service.ts";
import type { SessionEntry } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { structuredRecall, type StructuredFact } from "./support/structured-recall.ts";

const AT = Date.parse("2026-10-01T12:00:00Z");

function gbrain(answer: () => StructuredFact[]): MemoryService {
  const client = structuredRecall(() => answer().map((fact) => ({ date: "2026-10-30", kind: "fact", ...fact })));
  return createMcpMemoryProvider({ read: { client, tool: "memory_recall", timeoutMs: 1000 } });
}

function textProvider(lines: string[]): MemoryService {
  const client: McpClient = {
    async listTools() {
      return { tools: [] };
    },
    async callTool() {
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
  return createMcpMemoryProvider({ read: { client, tool: "search", timeoutMs: 1000 } });
}

function routed(notebook: MemoryService, providers: Record<string, MemoryService>, scopes = ["personal"]) {
  const routes: MemoryProviderRoute[] = [
    { provider: "default", scopes: ["personal", "org", "channel"] },
    ...Object.keys(providers).map((provider) => ({ provider, scopes, manage: false, failOpen: true })),
  ];
  return createRoutedMemoryService({ providers: { default: notebook, ...providers }, routes });
}

const entry = (record: unknown, seq: number): SessionEntry => ({
  sessionId: "s",
  seq,
  type: "user",
  parentSeq: null,
  createdAt: 1,
  scopeLabel: "personal:a",
  payload: { text: "hello", memoryRecall: JSON.parse(JSON.stringify(record)) },
});

test("a full first-provider batch leaves room for a relevant hit from the next provider", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  await notebook.capture(
    "personal:a",
    Array.from({ length: 20 }, (_, i) => `launch note ${i}`),
    AT,
  );
  const memory = routed(notebook, { acme: gbrain(() => [{ id: "4821", text: "The launch moved to Friday" }]) });
  const hits = await searchAcrossScopes(memory, ["personal:a"], "launch", 20);
  assert.equal(hits.length, 20);
  assert.equal(hits[1]?.fact, "acme:4821 (2026-10-30; fact) The launch moved to Friday");
});

test("equal fact ids from two brains and the notebook stay separate copies, and only the notebook copy is withdrawn", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  await notebook.capture("personal:a", ["Notebook copy"], AT);
  const [own] = await notebook.facts!("personal:a");
  const memory = routed(notebook, {
    alpha: gbrain(() => [{ id: own!.id, text: "Alpha copy" }]),
    beta: gbrain(() => [{ id: own!.id, text: "Beta copy" }]),
  });
  const held = async () => new Map([["personal:a", shownFacts(await notebook.facts!("personal:a"))]]);
  const outcomes: MemoryProviderOutcome[] = [];
  const report = (outcome: MemoryProviderOutcome) => void outcomes.push(outcome);
  const first = memoryRecallDelta(
    await recallAcrossScopes(memory, ["personal:a"], { query: "copy", report }),
    [],
    await held(),
    new Map(),
    outcomes,
  );
  assert.deepEqual(
    first.record.shown.map(({ id, provider }) => ({ id, provider })),
    [
      { id: own!.id, provider: undefined },
      { id: undefined, provider: "alpha" },
      { id: undefined, provider: "beta" },
    ],
  );
  const hits = await searchAcrossScopes(memory, ["personal:a"], "copy", 20);
  assert.deepEqual(
    hits.map(({ fact }) => fact.split(" ")[0]),
    [`#${own!.id}`, `alpha:${own!.id}`, `beta:${own!.id}`],
  );
  await notebook.delete!("personal:a", [own!.id]);
  outcomes.length = 0;
  const next = memoryRecallDelta(
    await recallAcrossScopes(memory, ["personal:a"], { query: "copy", report }),
    [entry(first.record, 1)],
    await held(),
    new Map(),
    outcomes,
  );
  assert.equal(next.text, "personal:a: 1 earlier fact was consolidated or removed; rely only on the current list.");
});

test("one claim in two notebooks prints once, in the scope whose turn reached it, with that scope's own id", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  await notebook.capture("personal:a", ["Dana prefers email"], AT);
  await notebook.capture("org:acme", ["dana prefers email ", "Offsite is in May"], AT);
  const [mine] = await notebook.facts!("personal:a");
  const recalled = await recallAcrossScopes(notebook, ["personal:a", "org:acme"], { query: "dana" });
  assert.deepEqual(
    recalled.map(({ scope, id, text }) => [scope, id, text]),
    [
      ["personal:a", mine!.id, "- (2026-10-01) Dana prefers email"],
      ["org:acme", (await notebook.facts!("org:acme"))[1]!.id, "- (2026-10-01) Offsite is in May"],
    ],
  );
  const hits = await searchAcrossScopes(notebook, ["personal:a", "org:acme"], "dana", 20);
  assert.deepEqual(hits, [{ scopeId: "personal:a", fact: `#${mine!.id} (2026-10-01) Dana prefers email` }]);
});

test("an id-less provider keeps its own lines and order, and an exact copy of a notebook claim prints once", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  await notebook.capture("personal:a", ["Dana prefers email"], AT);
  const memory = routed(notebook, { plain: textProvider(["zeta first", "Dana prefers email", "alpha last"]) });
  const recalled = await recallAcrossScopes(memory, ["personal:a"], { query: "q" });
  assert.deepEqual(
    recalled.map(({ text, source }) => [text, source?.provider]),
    [
      ["- (2026-10-01) Dana prefers email", undefined],
      ["zeta first", "plain"],
      ["alpha last", "plain"],
    ],
  );
});

test("a dual-written duplicate prints once as the notebook copy and gains no rank, and search names the brain copy", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  for (const [i, text] of ["alpha duplicate", "alpha one", "alpha two", "alpha three"].entries())
    await notebook.capture("personal:a", [text], AT + i);
  const memory = routed(notebook, {
    acme: gbrain(() => [
      { id: "1", text: "alpha brain one" },
      { id: "2", text: "alpha brain two" },
      { id: "77", text: "alpha duplicate" },
    ]),
  });
  const out = renderRecall(await recallAcrossScopes(memory, ["personal:a"], { query: "alpha" }), new Map());
  assert.equal(
    out,
    [
      "### personal:a",
      "```untrusted-data",
      "- (2026-10-01) alpha three",
      "- (2026-10-01) alpha two",
      "- (2026-10-01) alpha one",
      "- (2026-10-01) alpha duplicate",
      "```",
      "",
      "### personal:a · acme",
      "```untrusted-data",
      "- (2026-10-30; fact) alpha brain one",
      "- (2026-10-30; fact) alpha brain two",
      "```",
    ].join("\n"),
  );
  const [duplicate] = await notebook.facts!("personal:a");
  const hits = await searchAcrossScopes(memory, ["personal:a"], "alpha", 20);
  assert.equal(hits.filter(({ fact }) => fact.includes("alpha duplicate")).length, 1);
  assert.equal(hits[0]?.fact, `#${duplicate!.id} (2026-10-01) alpha duplicate (also acme:77)`);
});

test("every scope gets a turn and the 6,000 character budget holds, headings and fences included, as scope counts vary", async () => {
  for (const count of [1, 8]) {
    const notebook = createPostgresMemoryService(testDatabaseUrl());
    const scopes = Array.from({ length: count }, (_, i) => `channel:c${count}x${i}`);
    const facts = (scope: string) => Array.from({ length: 30 }, (_, i) => `${scope} fact ${i} ${"y".repeat(80)}`);
    for (const scope of scopes) await notebook.capture(scope, facts(scope), AT);
    const brain = gbrain(() => facts(scopes[0]!).map((text, i) => ({ id: `fact-${i}`, text: `brain ${text}` })));
    const memory = routed(notebook, { acme: brain }, ["channel"]);
    const out = renderRecall(await recallAcrossScopes(memory, scopes, { query: "fact" }), new Map());
    assert.ok(out.length <= 6000, `${count} scopes rendered ${out.length} characters`);
    assert.ok(out.length > 5000, `${count} scopes rendered only ${out.length} characters`);
    for (const scope of [...scopes, `${scopes[0]} · acme`]) assert.match(out, new RegExp(`^### ${scope}$`, "m"));
  }
});
