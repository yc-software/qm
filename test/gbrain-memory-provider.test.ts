import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Errors } from "typebox/value";
import { installPrincipalLinks } from "../src/directory/person.ts";
import type { MemoryProviderOutcome, MemoryService } from "../src/memory/memory-service.ts";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";
import { createRegistryMemoryService } from "../src/memory/registry-memory.ts";
import { forgetFacts, withProviders, writeFacts } from "../src/memory/provider-outcome.ts";
import { EMPTY_MEMORY_REGISTRY, putBinding, putBrain, type MemoryRegistry } from "../src/memory/registry.ts";
import { createPerTurnStrategy } from "../src/memory/strategies/per-turn.ts";
import { recallAcrossScopes } from "../src/memory/cross-scope.ts";
import { memoryRecallQuery } from "../src/memory/semantic-recall.ts";
import { type NewItem, storedItem } from "../src/sessions/items.ts";
import { routedTo, startMcpTestServer } from "./support/mcp-test-server.ts";
import { emptyMemoryRegistry } from "./support/memory-registry.ts";

interface ContractTool {
  name: string;
  description: string;
  mutating: boolean;
  input_schema: Tool["inputSchema"] & { properties: Record<string, unknown> };
}

const contract = JSON.parse(
  readFileSync(new URL("./fixtures/gbrain/qm-memory-provider-v3.json", import.meta.url), "utf8"),
) as {
  tools: ContractTool[];
  personal_tools: { tools: ContractTool[] };
  actor: { header: string; argument: string; actor_id: { pattern: string } };
  memory_recall: { limits: { max_chars: { min: number; max: number } } };
  unlinked_recall: CallToolResult;
  memory_write: {
    limits: { facts: { min: number; max: number }; provenance_chars: number; idempotency_key: { pattern: string } };
    committed: { content: string };
    pending: { content: string };
  };
  errors: { codes: Array<{ code: string; class: string; summary: string; reasons?: Array<{ reason: string }> }> };
};

const contractTools = [...contract.tools, ...contract.personal_tools.tools];

const guide = readFileSync(new URL("../docs/memory-providers.md", import.meta.url), "utf8");
const recipe = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(guide.split("\n## gbrain\n")[1] ?? "")?.[1] ?? "null") as {
  providers: Array<Record<string, unknown>>;
  routes: unknown[];
};

const SECRETS = {
  GBRAIN_RO_CLIENT_ID: "ro",
  GBRAIN_RO_CLIENT_SECRET: "x",
  GBRAIN_RW_CLIENT_ID: "rw",
  GBRAIN_RW_CLIENT_SECRET: "y",
};
const JORDAN = "personal:U0JORDAN";

interface Call {
  name: string;
  args: Record<string, unknown>;
  actor?: string;
}

async function gbrain(
  t: { after(fn: () => Promise<void>): void },
  answer: (name: string, args: Record<string, unknown>) => CallToolResult,
  routes = recipe.routes,
  record: MemoryRegistry | null = null,
) {
  installPrincipalLinks({
    canonical: (key) => (key === "jordan@acme.example" || key === "U0JORDAN" ? "U0JORDAN" : undefined),
    aliases: () => [],
  });
  t.after(async () => installPrincipalLinks(null));
  const calls: Call[] = [];
  const server = await startMcpTestServer(t, {
    tools: contractTools.map(({ name, description, input_schema }) => ({
      name,
      description,
      inputSchema: input_schema,
    })),
    clients: { ro: "x", rw: "y" },
    stateless: true,
    json: true,
    call: (name, args, _authorization, actor) => {
      calls.push({ name, args, ...(actor ? { actor } : {}) });
      return answer(name, args);
    },
  });
  const notebookWrites: string[] = [];
  const notebook: MemoryService = {
    async recall() {
      return [{ text: "notebook fact" }];
    },
    async capture(_scope, facts) {
      notebookWrites.push(...facts);
      return facts.length;
    },
    async query() {
      return [];
    },
    async read() {
      return "";
    },
    async facts() {
      return [];
    },
  };
  const memory = createRegistryMemoryService({
    registry: { ...emptyMemoryRegistry, current: async () => ({ version: "1", record }) },
    registryFetch: routedTo(server.url),
    defaultMemory: notebook,
    overlay: parseMemoryProviderConfig(
      JSON.stringify({ ...recipe, routes, providers: [{ ...recipe.providers[0], url: server.url }] }),
      SECRETS,
    ),
    onError: () => {},
  });
  return { server, calls, memory, notebookWrites };
}

function violations({ name, args }: Call): string[] {
  const tool = contractTools.find((entry) => entry.name === name);
  if (!tool) return [`${name} is not a contract tool`];
  const undeclared = tool.mutating ? Object.keys(args).filter((key) => !(key in tool.input_schema.properties)) : [];
  return [
    ...[...Errors(tool.input_schema, args)].map(({ instancePath, message }) => `${name}${instancePath} ${message}`),
    ...undeclared.map((key) => `${name}/${key} is not declared, and gbrain refuses unknown arguments to a write`),
  ];
}

const gbrainOutcomes = (outcomes: readonly MemoryProviderOutcome[]) =>
  outcomes
    .filter(({ provider }) => provider === "gbrain")
    .map(({ outcome, code }) => (code ? `${outcome}:${code}` : outcome));
const recallLines = (facts: Array<{ text: string; date: string; kind: string }>) =>
  facts.map(({ text, date, kind }) => `- ${text} (${date}; ${kind})`).join("\n");
const committed = (n: number, requestId: string): CallToolResult => ({
  content: [{ type: "text", text: contract.memory_write.committed.content.replace("<N>", String(n)) }],
  structuredContent: { status: "committed", request_id: requestId, fact_ids: ["43"] },
});
const refusal = (code: string, reason?: string): CallToolResult => {
  const { summary } = contract.errors.codes.find((entry) => entry.code === code) ?? { summary: "" };
  const error = { code, message: summary, ...(reason ? { reason } : {}) };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ...error, suggestion: "" }) }],
    structuredContent: { error },
  };
};

test("the documented gbrain recipe keeps the notebook first everywhere and sends only personal turns to gbrain", async (t) => {
  const facts = [{ id: "41", text: "Prefers aisle seats", date: "2026-10-30", kind: "preference" }];
  const { calls, memory, notebookWrites } = await gbrain(t, (name) =>
    name === "memory_recall"
      ? { content: [{ type: "text", text: recallLines(facts) }], structuredContent: { facts, truncated: false } }
      : committed(1, "8c1f7a0e-0000-5000-8000-000000000001"),
  );

  const answered: Record<string, string[]> = {};
  for (const scope of ["personal:U0JORDAN", "channel:C0ROOM", "group:G0CREW", "team:T0ACME", "org:acme"]) {
    const { outcomes } = await withProviders("search", (report) =>
      memory.recall(scope, { query: "seats", actorId: "U0JORDAN", audienceScopeId: scope, maxChars: 6000, report }),
    );
    answered[scope] = outcomes.map(({ provider, scope: answeredScope }) => `${provider}@${answeredScope}`).sort();
  }
  assert.deepEqual(answered, {
    "personal:U0JORDAN": ["default@personal:U0JORDAN", "gbrain@personal:U0JORDAN"],
    "channel:C0ROOM": ["default@channel:C0ROOM"],
    "group:G0CREW": ["default@group:G0CREW"],
    "team:T0ACME": ["default@team:T0ACME"],
    "org:acme": ["default@org:acme"],
  });

  await memory.capture(
    JORDAN,
    ["Prefers window seats"],
    1,
    { actorId: "U0JORDAN", context: "conversation" },
    { mode: "automatic", audienceScopeId: JORDAN },
  );
  assert.deepEqual(notebookWrites, ["Prefers window seats"]);
  assert.deepEqual(
    calls.map(({ name }) => name),
    ["memory_recall"],
  );
});

test("QM's gbrain requests satisfy the vendored contract's tools and actor rules", async (t) => {
  const { server, calls, memory } = await gbrain(t, (name) =>
    name === "memory_recall"
      ? { content: [{ type: "text", text: "" }], structuredContent: { facts: [], truncated: false } }
      : committed(1, "8c1f7a0e-0000-5000-8000-000000000002"),
  );
  const by = { actorId: "jordan@acme.example", context: "conversation" as const };
  const context = { mode: "explicit" as const, audienceScopeId: JORDAN, conversationScopeId: JORDAN };
  await withProviders("search", (report) =>
    memory.recall(JORDAN, {
      query: "seats",
      actorId: "jordan@acme.example",
      audienceScopeId: JORDAN,
      maxChars: 6000,
      report,
    }),
  );
  await writeFacts(memory, JORDAN, ["Prefers aisle seats", "Takes notes by hand"], by, context, "run-1");
  await writeFacts(memory, JORDAN, ["Prefers aisle seats", "Takes notes by hand"], by, context, "run-1");
  await writeFacts(memory, JORDAN, ["Prefers aisle seats", "Takes notes by hand"], by, context, undefined);

  const [recall, ...writes] = calls;
  assert.deepEqual(calls.flatMap(violations), []);
  assert.equal(recall?.name, "memory_recall");
  const maxChars = Number(recall?.args.max_chars);
  const { min, max } = contract.memory_recall.limits.max_chars;
  assert.ok(maxChars >= min && maxChars <= max, `max_chars ${maxChars} is outside ${min}-${max}`);

  assert.deepEqual(
    calls.map(({ actor, args }) => [actor, args[contract.actor.argument]]),
    Array(4).fill(["U0JORDAN", "U0JORDAN"]),
  );
  const sent = server.requests.filter(({ rpc }) => rpc).map(({ actor }) => actor);
  assert.deepEqual(new Set(sent), new Set(["U0JORDAN"]));
  for (const actor of sent) assert.match(String(actor), new RegExp(contract.actor.actor_id.pattern));
  assert.deepEqual(
    server.requests.filter(({ method }) => method === "DELETE"),
    [],
  );

  const { limits } = contract.memory_write;
  const keys = writes.map(({ args }) => String(args.idempotency_key));
  for (const key of keys) assert.match(key, new RegExp(limits.idempotency_key.pattern));
  assert.equal(keys[1], keys[0]);
  assert.notEqual(keys[2], keys[0]);
  for (const { args } of writes) {
    const facts = args.facts as Array<{ fact: string; provenance: string }>;
    assert.ok(facts.length >= limits.facts.min && facts.length <= limits.facts.max);
    assert.deepEqual(
      facts.map(({ fact }) => fact),
      ["Prefers aisle seats", "Takes notes by hand"],
    );
    for (const { provenance } of facts) {
      assert.ok(provenance.length >= 1 && provenance.length <= limits.provenance_chars);
      assert.doesNotMatch(provenance, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|^qm:/i);
    }
  }
});

test("gbrain's answers and refusals become the outcomes the contract classes them as", async (t) => {
  const facts = [
    { id: "41", text: "Prefers aisle seats", date: "2026-10-30", kind: "preference" },
    { id: "42", text: "Takes notes by hand", date: "2026-10-31", kind: "commitment" },
  ];
  let answer: CallToolResult = { content: [] };
  const { memory } = await gbrain(t, () => answer);
  const recall = async (result: CallToolResult) => {
    answer = result;
    const { value, outcomes } = await withProviders("search", (report) =>
      memory.recall(JORDAN, { query: "seats", actorId: "U0JORDAN", audienceScopeId: JORDAN, maxChars: 6000, report }),
    );
    const rows = (value ?? []).filter(({ source }) => source?.provider === "gbrain").map(({ text }) => text);
    return { outcome: gbrainOutcomes(outcomes).join(","), rows };
  };

  assert.deepEqual(
    await recall({
      content: [{ type: "text", text: recallLines(facts) }],
      structuredContent: { facts, truncated: false },
    }),
    { outcome: "ok", rows: facts.map(({ text, date, kind }) => `- (${date}; ${kind}) ${text}`) },
  );
  assert.deepEqual(
    await recall({ content: [{ type: "text", text: "" }], structuredContent: { facts: [], truncated: false } }),
    { outcome: "empty", rows: [] },
  );
  assert.deepEqual(await recall(contract.unlinked_recall), { outcome: "empty:actor_unlinked", rows: [] });

  const expected = (code: string, cls: string) => `${cls === "host_only" ? "denied" : "failed"}:${code}`;
  for (const { code, class: cls, reasons } of contract.errors.codes)
    for (const reason of reasons?.map((entry) => entry.reason) ?? [undefined])
      assert.deepEqual(
        await recall(refusal(code, reason)),
        { outcome: expected(code, cls), rows: [] },
        `${code}/${reason}`,
      );

  const write = async (result: CallToolResult) => {
    answer = result;
    const { outcomes } = await writeFacts(
      memory,
      JORDAN,
      ["Prefers aisle seats"],
      { actorId: "U0JORDAN", context: "conversation" },
      {
        mode: "explicit",
        audienceScopeId: JORDAN,
      },
      "run-1",
    );
    return gbrainOutcomes(outcomes).join(",");
  };
  assert.equal(await write(committed(1, "8c1f7a0e-0000-5000-8000-000000000003")), "committed");
  assert.equal(
    await write({
      content: [{ type: "text", text: contract.memory_write.pending.content.replace("<N>", "1").replace("<M>", "1") }],
      structuredContent: {
        status: "pending",
        request_id: "8c1f7a0e-0000-5000-8000-000000000004",
        fact_ids: [],
        pending_request_ids: ["8c1f7a0e-0000-5000-8000-000000000005"],
      },
    }),
    "pending",
  );
  for (const { code, class: cls } of contract.errors.codes)
    assert.equal(await write(refusal(code)), expected(code, cls), code);
});

test("a registry gbrain brain forgets a member's fact with the contract's forget_fact, and an unfinished one is pending", async (t) => {
  const change = { actor: "admin", now: 1, overlayIds: new Set<string>(), key: emptyMemoryRegistry.key };
  const brain = { preset: "gbrain-v1", url: "https://brain.acme.example/mcp", clientId: "rw", clientSecret: "y" };
  const record = putBinding(
    putBrain(EMPTY_MEMORY_REGISTRY, "jordan-brain", { ...brain, label: "Jordan's brain" }, change),
    "jordan",
    { brain: "jordan-brain", scope: JORDAN, capture: "explicit" },
    change,
  );
  const { calls, memory } = await gbrain(
    t,
    (_name, args) => ({
      content: [],
      structuredContent: { id: args.id, request_id: args.request_id, state: args.id === 41 ? "committed" : "running" },
    }),
    [],
    record,
  );
  const forgot = await forgetFacts(
    memory,
    JORDAN,
    ["jordan-brain:41", "jordan-brain:42"],
    { actorId: "U0JORDAN", context: "conversation", personTurn: true },
    { audienceScopeId: JORDAN },
    "session:call",
  );
  assert.deepEqual(
    forgot.outcomes.map(({ ref, outcome, code }) => `${ref} ${outcome}${code ? ` ${code}` : ""}`),
    ["jordan-brain:41 committed", "jordan-brain:42 pending running"],
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    ["forget_fact", "forget_fact"],
  );
  assert.deepEqual(calls.flatMap(violations), []);
  assert.ok(calls.every(({ actor }) => actor === "U0JORDAN"));
});

test("an attested gbrain write never speaks for anyone but the turn's member", async (t) => {
  const { calls, memory, notebookWrites } = await gbrain(t, () => committed(1, "8c1f7a0e-0000-5000-8000-000000000006"));
  const { outcomes } = await writeFacts(
    memory,
    "personal:U0ALICE",
    ["Onboarding: completed v1"],
    { actorId: "U0ADMIN", context: "admin" },
    { mode: "explicit" },
    undefined,
  );
  const system = await writeFacts(
    memory,
    "personal:U0ALICE",
    ["Channel history was missing"],
    { actorId: "system:channel:C0ROOM", context: "maintenance" },
    { mode: "explicit" },
    "run-2",
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(notebookWrites, ["Onboarding: completed v1", "Channel history was missing"]);
  assert.deepEqual(gbrainOutcomes(outcomes), []);
  assert.deepEqual(gbrainOutcomes(system.outcomes), []);
});

test("a gbrain write's provenance stays within the contract's limit for a long sign-in", async (t) => {
  const { calls, memory } = await gbrain(t, () => committed(1, "8c1f7a0e-0000-5000-8000-000000000007"));
  const signIn = `${"x".repeat(250)}@acme.example`;
  installPrincipalLinks({
    canonical: (key) => (key === signIn || key === "U0JORDAN" ? "U0JORDAN" : undefined),
    aliases: () => [],
  });
  const scope = `personal:${signIn}` as const;
  const { outcomes } = await writeFacts(
    memory,
    scope,
    ["Prefers aisle seats"],
    { actorId: "U0JORDAN", context: "conversation" },
    { mode: "explicit", audienceScopeId: scope, conversationScopeId: scope },
    "run-3",
  );
  assert.deepEqual(gbrainOutcomes(outcomes), ["committed"]);
  assert.deepEqual(calls.flatMap(violations), []);
  const [fact] = calls[0]!.args.facts as Array<{ provenance: string }>;
  assert.equal(fact?.provenance, scope.slice(0, contract.memory_write.limits.provenance_chars));
});

test("automatic capture of more than 20 facts reaches gbrain as writes within the contract, each with its own key", async (t) => {
  const [notebookRoute, gbrainRoute] = recipe.routes as Array<Record<string, unknown>>;
  const { calls, memory, notebookWrites } = await gbrain(
    t,
    () => committed(20, "8c1f7a0e-0000-5000-8000-000000000008"),
    [notebookRoute, { ...gbrainRoute, capture: "automatic" }],
  );
  const facts = Array.from({ length: 45 }, (_, i) => `Prefers seat ${i + 1}`);
  const strategy = createPerTurnStrategy({
    agent: { oneShot: async () => `SENSITIVITY: ordinary\n${facts.map((fact) => `- ${fact}`).join("\n")}` },
    memory,
  });
  await strategy.onTurnEnd!({
    scopeId: JORDAN,
    actorId: "U0JORDAN",
    audienceScopeId: JORDAN,
    idempotencyKey: "run-4",
    input: "My seats",
    reply: "Noted",
  });

  const { limits } = contract.memory_write;
  assert.deepEqual(calls.flatMap(violations), []);
  const writes = calls.map(({ args }) => ({
    facts: (args.facts as Array<{ fact: string }>).map(({ fact }) => fact),
    key: String(args.idempotency_key),
  }));
  for (const write of writes) {
    assert.ok(write.facts.length >= limits.facts.min && write.facts.length <= limits.facts.max);
    assert.match(write.key, new RegExp(limits.idempotency_key.pattern));
  }
  assert.deepEqual(
    writes.flatMap((write) => write.facts),
    facts,
  );
  assert.equal(new Set(writes.map(({ key }) => key)).size, writes.length);
  assert.deepEqual(notebookWrites, facts);
});

test("a strict gbrain route that refuses a later batch still leaves every automatic fact in the notebook", async (t) => {
  const [notebookRoute, gbrainRoute] = recipe.routes as Array<Record<string, unknown>>;
  let writes = 0;
  const { memory, notebookWrites } = await gbrain(
    t,
    () => (++writes > 1 ? refusal("invalid_params") : committed(20, "8c1f7a0e-0000-5000-8000-000000000009")),
    [notebookRoute, { ...gbrainRoute, capture: "automatic", failOpen: false }],
  );
  const facts = Array.from({ length: 45 }, (_, i) => `Prefers seat ${i + 1}`);
  const strategy = createPerTurnStrategy({
    agent: { oneShot: async () => `SENSITIVITY: ordinary\n${facts.map((fact) => `- ${fact}`).join("\n")}` },
    memory,
  });
  await assert.rejects(
    strategy.onTurnEnd!({
      scopeId: JORDAN,
      actorId: "U0JORDAN",
      audienceScopeId: JORDAN,
      idempotencyKey: "run-5",
      input: "My seats",
      reply: "Noted",
    }),
    /invalid_params/,
  );
  assert.deepEqual(notebookWrites, facts);
});

test("a long conversation's recall asks gbrain with the member's message, within gbrain's question limit", async (t) => {
  const quartet = [{ id: "7", text: "Plays viola in a string quartet", date: "2026-11-02", kind: "fact" }];
  const { calls, memory } = await gbrain(t, (_name, args) => {
    const facts = String(args.query).trim().slice(0, 2000).includes("quartet") ? quartet : [];
    return { content: [{ type: "text", text: recallLines(facts) }], structuredContent: { facts, truncated: false } };
  });
  const entry = (item: NewItem) => storedItem(item, { sessionId: "s", seq: 1, createdAt: 1 });
  const dialogue = "We went through the quarterly plan, the hiring loop and the vendor renewal in detail. ".repeat(12);
  const history = [
    entry({ kind: "UserMessage", text: dialogue }),
    entry({ kind: "AgentMessage", text: dialogue }),
    entry({ kind: "UserMessage", text: dialogue }),
    entry({ kind: "AgentMessage", text: dialogue }),
  ];
  const message = "Which instrument do I play in my string quartet?";
  const recalled = await recallAcrossScopes(memory, [JORDAN], {
    query: memoryRecallQuery(message, history),
    input: message,
    actorId: "U0JORDAN",
    audienceScopeId: JORDAN,
    maxChars: 6000,
  });

  assert.deepEqual(
    calls.map(({ args }) => args.query),
    [message],
  );
  assert.ok(recalled.some(({ text }) => text.includes("Plays viola in a string quartet")));
});
