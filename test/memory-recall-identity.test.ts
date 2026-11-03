import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpMemoryProvider } from "../src/memory/mcp-memory-provider.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createRoutedMemoryService, type MemoryProviderRoute } from "../src/memory/provider-router.ts";
import { recallAcrossScopes, renderRecall, searchAcrossScopes } from "../src/memory/cross-scope.ts";
import { memoryRecallDelta, shownFacts } from "../src/memory/recall-delta.ts";
import { McpCallError, type McpClient } from "../src/mcp/mcp-client.ts";
import { TimeoutError } from "../src/util/async.ts";
import type { MemoryProviderOutcome, MemoryService } from "../src/memory/memory-service.ts";
import type { SessionEntry } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const AT = Date.parse("2026-10-01T12:00:00Z");

interface BrainFact {
  id: string;
  text: string;
  arm?: string;
}

function gbrain(id: string, answer: () => BrainFact[] | Error): MemoryService {
  const client: McpClient = {
    async listTools() {
      return { tools: [] };
    },
    async callTool() {
      const facts = answer();
      if (facts instanceof Error) throw facts;
      const rows = facts.map((fact) => ({ date: "2026-10-30", kind: "fact", ...fact }));
      return {
        content: [{ type: "text", text: rows.map((fact) => `- ${fact.text} (${fact.date}; ${fact.kind})`).join("\n") }],
        structuredContent: { facts: rows, truncated: false },
      };
    },
  };
  return createMcpMemoryProvider({ id, read: { client, tool: "memory_recall", timeoutMs: 1000 } });
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
  return createMcpMemoryProvider({ id: "plain", read: { client, tool: "search", timeoutMs: 1000 } });
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
  const memory = routed(notebook, { acme: gbrain("acme", () => [{ id: "4821", text: "The launch moved to Friday" }]) });
  const hits = await searchAcrossScopes(memory, ["personal:a"], "launch", 20);
  assert.equal(hits.length, 20);
  assert.equal(hits[1]?.fact, "acme:4821 The launch moved to Friday (2026-10-30; fact)");
});

test("equal fact ids from two brains and the notebook stay separate copies, and only the notebook copy is withdrawn", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  await notebook.capture("personal:a", ["Notebook copy"], AT);
  const [own] = await notebook.facts!("personal:a");
  const memory = routed(notebook, {
    alpha: gbrain("alpha", () => [{ id: own!.id, text: "Alpha copy" }]),
    beta: gbrain("beta", () => [{ id: own!.id, text: "Beta copy" }]),
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
    first.record.shown.map(({ id, ref, provider }) => ({ id, ref, provider })),
    [
      { id: own!.id, ref: undefined, provider: undefined },
      { id: undefined, ref: `alpha:${own!.id}`, provider: "alpha" },
      { id: undefined, ref: `beta:${own!.id}`, provider: "beta" },
    ],
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

test("one claim in a writable and a read-only notebook is shown once, under its own scope and id", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  await notebook.capture("personal:a", ["Dana prefers email"], AT);
  await notebook.capture("org:acme", ["Dana prefers email", "Offsite is in May"], AT);
  const [mine] = await notebook.facts!("personal:a");
  const [theirs] = await notebook.facts!("org:acme");
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
  assert.ok(!JSON.stringify(hits).includes(`#${theirs!.id} `));
});

test("an id-less provider keeps its own lines and order, and an exact copy of a notebook claim prints once", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  await notebook.capture("personal:a", ["Dana prefers email"], AT);
  const memory = routed(notebook, { plain: textProvider(["zeta first", "Dana prefers email", "alpha last"]) });
  const recalled = await recallAcrossScopes(memory, ["personal:a"], { query: "q" });
  assert.deepEqual(
    recalled.map(({ text, ref, source }) => [text, ref, source?.provider]),
    [
      ["- (2026-10-01) Dana prefers email", undefined, undefined],
      ["zeta first", undefined, "plain"],
      ["alpha last", undefined, "plain"],
    ],
  );
});

test("gbrain's own-recent facts no longer starve an older relevant fact once rows carry their arm", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  const recent = Array.from({ length: 60 }, (_, i) => ({
    id: String(i),
    text: `recent chatter ${i} ${"x".repeat(110)}`,
    arm: "own",
  }));
  const relevant = { id: "900", text: `Dana's board meeting is on the 14th ${"x".repeat(110)}`, arm: "ranked" };
  const render = async (facts: BrainFact[]) =>
    renderRecall(
      await recallAcrossScopes(routed(notebook, { acme: gbrain("acme", () => facts) }), ["personal:a"], {
        query: "board meeting",
      }),
      new Map(),
    );
  const marked = await render([...recent, relevant]);
  assert.ok(marked.length <= 6000);
  assert.match(marked, /^- recent chatter 0 x+ \(2026-10-30; fact\)\n- Dana's board meeting/m);
  const unmarked = await render([...recent, relevant].map(({ arm: _arm, ...fact }) => fact));
  assert.match(unmarked, /recent chatter 0 /);
  assert.doesNotMatch(unmarked, /board meeting/);
});

test("a dual-written duplicate prints once as the notebook copy naming the brain copy, and gains no rank", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  for (const [i, text] of ["alpha duplicate", "alpha one", "alpha two", "alpha three"].entries())
    await notebook.capture("personal:a", [text], AT + i);
  const memory = routed(notebook, {
    acme: gbrain("acme", () => [
      { id: "1", text: "alpha brain one", arm: "ranked" },
      { id: "2", text: "alpha brain two", arm: "ranked" },
      { id: "77", text: "alpha duplicate", arm: "ranked" },
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
      "- (2026-10-01) alpha duplicate (also acme:77)",
      "```",
      "",
      "### personal:a · acme",
      "```untrusted-data",
      "- alpha brain one (2026-10-30; fact)",
      "- alpha brain two (2026-10-30; fact)",
      "```",
    ].join("\n"),
  );
  const [duplicate] = await notebook.facts!("personal:a");
  const hits = await searchAcrossScopes(memory, ["personal:a"], "alpha", 20);
  assert.equal(hits.filter(({ fact }) => fact.includes("alpha duplicate")).length, 1);
  assert.equal(hits[0]?.fact, `#${duplicate!.id} (2026-10-01) alpha duplicate (also acme:77)`);
});

test("every scope gets a turn and the 6,000 character budget holds, copy names included, as scope counts vary", async () => {
  for (const count of [1, 3, 8]) {
    const notebook = createPostgresMemoryService(testDatabaseUrl());
    const scopes = Array.from({ length: count }, (_, i) => `channel:c${count}x${i}`);
    const facts = (scope: string) => Array.from({ length: 30 }, (_, i) => `${scope} fact ${i} ${"y".repeat(80)}`);
    for (const scope of scopes) await notebook.capture(scope, facts(scope), AT);
    const brain = gbrain("acme-company-brain", () =>
      facts(scopes[0]!).map((text, i) => ({ id: `fact-${i}-${"z".repeat(20)}`, text, arm: "ranked" })),
    );
    const memory = routed(notebook, { brain }, ["channel"]);
    const out = renderRecall(await recallAcrossScopes(memory, scopes, { query: "fact" }), new Map());
    assert.ok(out.length <= 6000, `${count} scopes rendered ${out.length} characters`);
    assert.ok(out.length > 5000, `${count} scopes rendered only ${out.length} characters`);
    for (const scope of scopes) assert.match(out, new RegExp(`^### ${scope}$`, "m"));
    assert.match(out, /\(also acme-company-brain:fact-\d+-z{20}\)$/m);
  }
});

test("brain refs keep the recall delta honest over twenty turns: new facts only, no false removals", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  await notebook.capture("personal:a", ["NOTEBOOK_FACT prefers terse replies"], AT);
  let window = 0;
  let failure: Error | undefined;
  const fact = (i: number): BrainFact => ({ id: String(i), text: `brain fact ${i}`, arm: "ranked" });
  const memory = routed(notebook, {
    acme: gbrain("acme", () => failure ?? Array.from({ length: 6 }, (_, k) => fact(window + k))),
  });
  const history: SessionEntry[] = [];
  const turn = async () => {
    const outcomes: MemoryProviderOutcome[] = [];
    const recalled = await recallAcrossScopes(memory, ["personal:a"], {
      query: "q",
      report: (outcome) => void outcomes.push(outcome),
    });
    const held = new Map([["personal:a", shownFacts(await notebook.facts!("personal:a"))]]);
    const delta = memoryRecallDelta(recalled, history, held, new Map(), outcomes);
    history.push(entry(delta.record, history.length + 1));
    return delta;
  };
  const block = (...ids: number[]) =>
    `### personal:a · acme\n\`\`\`untrusted-data\n${ids.map((i) => `- brain fact ${i} (2026-10-30; fact)`).join("\n")}\n\`\`\``;
  const first = await turn();
  assert.ok(first.text.includes(block(0, 1, 2, 3, 4, 5)));
  assert.ok(
    first.record.shown
      .filter(({ provider }) => provider === "acme")
      .every(({ id, ref }) => id === undefined && ref?.startsWith("acme:")),
  );
  for (window = 1; window < 20; window++) {
    assert.equal((await turn()).text, `New or updated memory facts:\n\n${block(window + 5)}`);
  }
  window = 19;
  failure = new TimeoutError("memory provider timed out after 1000ms");
  assert.equal((await turn()).text, "");
  failure = new McpCallError("mcp tools/call failed (HTTP 403)", { status: 403 });
  assert.equal(
    (await turn()).text,
    "Some previously recalled memory sources are no longer included. Do not rely on memory from sources that are not currently authorized.",
  );
});
