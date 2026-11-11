import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Agent } from "../src/agent/agent.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { turnToolRef } from "../src/agent/turn-open.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { TurnRequest } from "../src/types.ts";
import { sleep } from "../src/util/async.ts";
import type { AddressFetch } from "../src/util/network.ts";
import { buildApp } from "./support/build-app.ts";
import { routedTo, startMcpTestServer } from "./support/mcp-test-server.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";

type Row = Record<string, unknown>;
type Step = Row | ((texts: string[]) => Row) | "revoke";
interface Call {
  tool: string;
  args: Row;
  actor?: string;
}

const OPS = ["query", "get_page", "get_timeline", "get_backlinks", "find_experts", "whois", "entity", "context_pack"];
const HOT_MEMORY = "Alice prefers morning meetings before 10am.";
const CANARY = "The beta canary is violet-otter-4471 and must never leave brain beta.";
const OWN_WORDS = "what changed in the warehouse perception pilot";
const priya = { slug: "people/priya-raman", source_id: "default", title: "Priya Raman", type: "person" };
const alexes = ["people/alex-kim-helio", "people/alex-kim-tidepool"].map((slug) => ({
  ...priya,
  slug,
  title: "Alex Kim",
}));

const ACME: Record<string, (args: Row) => Row> = {
  query: () => ({
    results: [
      { ...priya, chunk_text: "Priya leads the warehouse robotics thesis.", chunk_id: 26, score: 1.1 },
      {
        result_type: "fact",
        fact_id: 4821,
        source_id: "default",
        title: "Alice",
        chunk_text: "Alice owes Priya a pilot summary.",
      },
    ],
  }),
  get_page: (args) => ({ ...priya, slug: args.slug, compiled_truth: "Priya Raman is a partner.", revision: "7" }),
  get_timeline: () => ({
    results: [
      { id: 4, date: "2026-11-14", source: "Calendar", summary: "Q4 roadmap", detail: "", write_principal_id: "w-1" },
    ],
  }),
  get_backlinks: (args) => ({
    results: [
      { from_slug: "meetings/q4-roadmap", from_source_id: "default", to_slug: args.slug, link_type: "mentions" },
    ],
  }),
  find_experts: () => ({ results: [{ ...priya, score: 0.4, factors: { recency: 1 } }] }),
  whois: (args) =>
    args.query === "Alex Kim"
      ? { query: args.query, matches: alexes.map((match) => ({ ...match, match: "title" })), ambiguous: true }
      : { query: args.query, matches: [{ ...priya, match: "title" }], ambiguous: false },
  entity: () => ({
    protocol_version: 1,
    found: true,
    card: {
      entity: priya,
      trust_tier: "operator_curated",
      summary: "Partner at Northwind.",
      edges: [{ type: "works_at", slug: "companies/northwind" }],
    },
  }),
  context_pack: () => ({
    brief: { counterparty: { slug: priya.slug, display: "Priya Raman" }, items: [{ ...priya, text: "Q4 roadmap" }] },
  }),
};

function gbrainAnswer(tool: string, args: Row, answers: Record<string, (args: Row) => Row>): CallToolResult {
  const structured = answers[tool]?.(args) ?? {};
  const text =
    tool === "context_pack" ? "<!-- retrieved brain context -->\n- 2026-11-14 Q4 roadmap" : JSON.stringify(structured);
  return {
    structuredContent: structured,
    content: [
      { type: "text", text },
      { type: "text", text: "[gbrain degraded: embed_unavailable] partial" },
    ],
    _meta: { brain_hot_memory: HOT_MEMORY },
  };
}

async function gbrain(t: { after(fn: () => Promise<void>): void }, answers: Record<string, (args: Row) => Row>) {
  const calls: Call[] = [];
  const failures = new Map<string, CallToolResult | number>();
  const server = await startMcpTestServer(t, {
    tools: [...OPS, "memory_recall", "memory_write"].map((name) => ({
      name,
      inputSchema: { type: "object" as const },
    })),
    clients: { qm: "brain-secret" },
    call: async (tool, args, _authorization, actor) => {
      calls.push({ tool, args, ...(actor ? { actor } : {}) });
      if (tool === "memory_recall") return { content: [] };
      const failure = failures.get(String(args.query ?? args.name));
      if (typeof failure === "number") await sleep(failure);
      else if (failure) return failure;
      return gbrainAnswer(tool, args, answers);
    },
  });
  return Object.assign(server, { calls, failures });
}

async function brainApp(
  t: { after(fn: () => Promise<void>): void },
  {
    brains = ["acme"],
    preset = "gbrain-v3",
    ...config
  }: { brains?: string[]; preset?: string; memoryBrainTool?: boolean } = {},
) {
  const acme = await gbrain(t, ACME);
  const beta = await gbrain(t, { query: () => ({ results: [{ ...priya, chunk_text: `${CANARY} ${OWN_WORDS}` }] }) });
  const script: Step[] = [];
  const runs: Array<{ tools: string[]; prompt: string; texts: string[] }> = [];
  const mock = createMockAgent();
  const agent: Agent = {
    ...mock,
    async runTurn(input) {
      const tools = createAgentTools(turnToolRef(input), {});
      const run = { tools: tools.map(({ name }) => name), prompt: input.systemPrompt, texts: [] as string[] };
      runs.push(run);
      if (!script.length) return mock.runTurn(input);
      await input.emit({ kind: "UserMessage", text: input.input, author: input.runtimeActorId ?? null, body: {} });
      const brain = tools.find(({ name }) => name === "brain")!;
      for (const step of script.splice(0)) {
        if (step === "revoke") await admin("DELETE", "/v1/admin/memory-registry/bindings/acme");
        else {
          const params = typeof step === "function" ? step(run.texts) : step;
          const result = await brain.execute(randomUUID(), params, undefined, undefined, {} as never);
          run.texts.push(result.content.map((block) => ("text" in block ? block.text : "")).join("\n"));
        }
      }
      await input.emit({ kind: "AgentMessage", text: "done" });
      return { reply: "done", modelCalls: 1 };
    },
  };
  const memoryRegistryFetch: AddressFetch = (input, init) =>
    routedTo(new URL(input).host.startsWith("brain.beta") ? beta.url : acme.url)(input, init);
  const built = buildApp(testConfig(config), { memoryRegistryFetch, agent });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    memory: built.memory,
    memoryRegistry: built.memoryRegistry,
    capabilitySecret: TEST_CAPABILITY_SECRET,
  });
  server.listen(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://localhost:${(server.address() as AddressInfo).port}${path}`, {
      method,
      headers: { "x-admin-actor": "admin-alice@default-org", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(res.status, 200, await res.text());
  };
  for (const id of brains) {
    const url = `https://brain.${id}.example/mcp`;
    const label = `${id[0]!.toUpperCase()}${id.slice(1)} brain`;
    await admin("PUT", `/v1/admin/memory-registry/brains/${id}`, {
      preset,
      url,
      clientId: "qm",
      clientSecret: "brain-secret",
      label,
      timeoutMs: 400,
    });
    await admin("PUT", `/v1/admin/memory-registry/bindings/${id}`, {
      brain: id,
      scope: "personal",
      capture: "explicit",
    });
  }
  const turn = async (steps: Step[], request: Partial<TurnRequest> = {}) => {
    script.splice(0, script.length, ...steps);
    const before = runs.length;
    await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `dm:U1:${randomUUID()}` },
      text: `Prep me for Priya, and ${OWN_WORDS}?`,
      ...request,
    });
    return runs.length > before ? runs.at(-1) : undefined;
  };
  return { built, acme, beta, turn };
}

const ops = (brain: { calls: Call[] }) => brain.calls.filter(({ tool }) => OPS.includes(tool));
const REF = "acme:default:people/priya-raman";

test("the brain tool comes only in the person's own DM, and the switch leaves recall alone", async (t) => {
  const { acme, turn } = await brainApp(t);
  const offered = async (request: Partial<TurnRequest>) => (await turn([], request))?.tools.includes("brain") ?? false;
  assert.equal(await offered({}), true);
  const others: Array<Partial<TurnRequest>> = [
    {
      conversation: {
        kind: "group",
        threadRef: "G1",
        channelRef: "G1",
        isMpim: true,
        audience: [{ externalId: "U1" }, { externalId: "U2" }],
      },
    },
    { conversation: { kind: "channel", threadRef: "C1", channelRef: "C1" } },
    { botActor: true },
    { origin: { kind: "ambient", live: true } },
    { actor: { externalId: "system:ambient:default-org" } },
  ];
  for (const request of others) assert.equal(await offered(request), false, JSON.stringify(request));
  assert.deepEqual(ops(acme), []);

  const off = await brainApp(t, { memoryBrainTool: false });
  assert.equal((await off.turn([]))?.tools.includes("brain"), false);
  assert.ok(off.acme.calls.some(({ tool }) => tool === "memory_recall"));
  const v1 = await brainApp(t, { preset: "gbrain-v1" });
  assert.equal((await v1.turn([]))?.tools.includes("brain"), false);
});

test("each action sends its own operation as the person, naming the record's source, and shows only its fields", async (t) => {
  const { acme, turn } = await brainApp(t);
  const { texts } = (await turn([
    { action: "whois", query: "Priya Raman" },
    { action: "page", ref: REF },
    { action: "timeline", ref: REF, after: "2026-11-01" },
    { action: "links", ref: REF },
    { action: "entity", ref: REF },
    { action: "brief", ref: REF },
    { action: "search", query: "robotics thesis" },
    { action: "experts", query: "robot perception" },
    { action: "whois", query: "Alex Kim" },
  ]))!;
  const page = { slug: "people/priya-raman", source_id: "default" };
  assert.deepEqual(ops(acme), [
    { tool: "whois", args: { query: "Priya Raman" }, actor: "U1" },
    { tool: "get_page", args: page, actor: "U1" },
    { tool: "get_timeline", args: { ...page, after: "2026-11-01" }, actor: "U1" },
    { tool: "get_backlinks", args: page, actor: "U1" },
    { tool: "entity", args: { name: page.slug, source_id: "default" }, actor: "U1" },
    { tool: "context_pack", args: { counterparty: page.slug, source_id: "default", intent: "meeting" }, actor: "U1" },
    { tool: "query", args: { query: "robotics thesis" }, actor: "U1" },
    { tool: "find_experts", args: { topic: "robot perception" }, actor: "U1" },
    { tool: "whois", args: { query: "Alex Kim" }, actor: "U1" },
  ]);
  assert.equal(
    texts[0],
    [
      "### brain · Acme brain",
      "```untrusted-data",
      `{"matches":[{"ref":"${REF}","title":"Priya Raman","type":"person","match":"title"}],"ambiguous":false}`,
      "",
      "[gbrain degraded: embed_unavailable] partial",
      "```",
    ].join("\n"),
  );
  assert.match(texts[2]!, /"summary":"Q4 roadmap"/);
  assert.match(texts[3]!, /"ref":"acme:default:meetings\/q4-roadmap"/);
  assert.match(texts[4]!, /"ref":"acme:default:companies\/northwind"/);
  assert.match(texts[5]!, /retrieved brain context/);
  assert.match(texts[6]!, /"ref":"acme:4821","title":"Alice"/);
  assert.match(texts[8]!, /Ask the person which one they mean/);
  assert.doesNotMatch(texts.join("\n"), /morning meetings|w-1|factors|chunk_id|revision/);
});

test("a forged brain, ref or action, an over-long lookup and a revoked binding never reach the brain", async (t) => {
  const { acme, turn } = await brainApp(t);
  const { texts } = (await turn([
    { action: "page", ref: "acme:default:notes/never-shown" },
    { action: "page", ref: REF },
    { brain: "elsewhere", action: "search", query: "robotics" },
    { action: "forget_fact", query: "robotics" },
    { action: "search", query: "robotics ".repeat(23) },
    "revoke",
    { action: "search", query: "robotics" },
  ]))!;
  assert.equal(texts.length, 6);
  for (const text of texts) assert.match(text, /^\[brain_refused\]/);
  assert.deepEqual(ops(acme), []);
});

test("a lookup that repeats another brain's words is refused, and the person's own words go through", async (t) => {
  const { acme, beta, turn } = await brainApp(t, { brains: ["acme", "beta"] });
  const { texts } = (await turn([
    { brain: "beta", action: "search", query: "canary" },
    { brain: "acme", action: "search", query: CANARY },
    { brain: "acme", action: "search", query: OWN_WORDS },
  ]))!;
  assert.match(texts[0]!, /violet-otter-4471/);
  assert.match(texts[1]!, /^\[brain_refused\]/);
  assert.deepEqual(
    ops(beta).map(({ args }) => args.query),
    ["canary"],
  );
  assert.deepEqual(
    ops(acme).map(({ args }) => args.query),
    [OWN_WORDS],
  );
});

test("a slow, unlinked or refusing brain answers with what to do next", async (t) => {
  const { acme, turn } = await brainApp(t);
  const refusal = (code: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ code, message: `refused with ${code}` }) }],
  });
  acme.failures.set("slow", 2_000);
  acme.failures.set("Nobody", refusal("actor_unlinked"));
  acme.failures.set("Missing", refusal("page_not_found"));
  const { texts } = (await turn([
    { action: "search", query: "slow" },
    { action: "whois", query: "Nobody" },
    { action: "entity", query: "Missing" },
  ]))!;
  assert.match(texts[0]!, /^\[memory_provider_timeout\] .*timed out after \d+ms/);
  assert.match(
    texts[1]!,
    /\[memory_provider_denied\] .*Link this member's QM principal id[\s\S]*refused with actor_unlinked/,
  );
  assert.match(texts[2]!, /\[brain_answered page_not_found\][\s\S]*refused with page_not_found/);
});

test("strict posture holds a brain lookup for approval, and dangerous runs it", async (t) => {
  const { built, acme, turn } = await brainApp(t);
  await built.config.setSecurityPosture("personal:U1", "strict");
  assert.match((await turn([{ action: "whois", query: "Priya Raman" }]))!.texts[0]!, /needs human approval/);
  assert.deepEqual(ops(acme), []);
  await built.config.setSecurityPosture("personal:U1", "dangerous");
  assert.match(
    (await turn([{ action: "whois", query: "Priya Raman" }]))!.texts[0]!,
    /acme:default:people\/priya-raman/,
  );
});
