import { testTenant } from "./support/test-tenant.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { createAgentTools, type ToolContextRef } from "../src/agent/agent-tools.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import { McpCallError, type McpClient } from "../src/mcp/mcp-client.ts";
import { createMcpMemoryProvider } from "../src/memory/mcp-memory-provider.ts";
import { TimeoutError } from "../src/util/async.ts";
import { reportEnvelope } from "../src/memory/provider-outcome.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import type { NewItem } from "../src/sessions/items.ts";

const at = Date.UTC(2026, 4, 31);

const noSandbox = {} as unknown as Sandbox;

function ctxFor(opts: {
  scope: ScopeId;
  memory: ReturnType<typeof createPostgresMemoryService>;
  memoryScopeId?: ScopeId;
  deps?: Partial<ToolContextDeps>;
}) {
  return createToolContext({
    tenant: testTenant,
    sandbox: noSandbox,
    provision: async () => {
      throw new Error("memory ops must not provision the sandbox");
    },
    writableScopeId: opts.scope,
    readOnlyScopeIds: [],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: opts.scope.split(":")[1] ?? opts.scope,
    memory: opts.memory,
    memoryScopeId: opts.memoryScopeId ?? opts.scope,
    memoryAccess: { write: opts.memoryScopeId ?? opts.scope, read: [opts.memoryScopeId ?? opts.scope] },
    ...opts.deps,
  });
}

test("memorySearch() queries ONLY the session's resolved memory scope, and is boundary-safe", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  const channel = scopeId("channel", "C1");
  await memory.capture(personal, ["Owns the billing service", "Prefers terse replies"], at);

  const personalCtx = ctxFor({ scope: personal, memory });
  assert.deepEqual((await personalCtx.memorySearch("billing"))?.hits, ["#1 (2026-05-31) Owns the billing service"]);
  assert.deepEqual((await personalCtx.memorySearch("kubernetes"))?.hits, []);

  const channelCtx = ctxFor({ scope: channel, memory });
  assert.deepEqual((await channelCtx.memorySearch("billing"))?.hits, []);
});

test("memorySearch() honors the explicit limit and never the model's scope (no scope param exists)", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  await memory.capture(personal, ["likes go", "likes golang", "likes good docs"], at);

  const ctx = ctxFor({ scope: personal, memory });
  const limited = await ctx.memorySearch("likes", 2);
  assert.equal(limited?.hits.length, 2);

  assert.deepEqual((await ctx.memorySearch("golang"))?.hits, ["#2 (2026-05-31) likes golang"]);
});

test("memory ops signal unavailable (null) when memory is not wired", async () => {
  const personal = scopeId("personal", "U1");
  const ctx = createToolContext({
    tenant: testTenant,
    sandbox: noSandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    writableScopeId: personal,
    readOnlyScopeIds: [],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
  assert.equal(await ctx.memorySearch("anything"), null);
  assert.equal(await ctx.memoryRead(), null);
  assert.equal(await ctx.memoryAdd(["a fact"]), null);
  assert.equal(await ctx.memoryEdit([{ id: "1", text: "x" }]), null);
  assert.equal(await ctx.memoryDelete(["1"], "call-1"), null);
});

const call = (tool: ReturnType<typeof createAgentTools>[number] | undefined, params: unknown) => {
  assert.ok(tool);
  return (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)("t", params);
};
const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

test("createAgentTools exposes ONE `memory` tool: search returns scope-keyed hits + emits a trace", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  await memory.capture(personal, ["Owns the billing service"], at);

  const emitted: NewItem[] = [];
  const ref: ToolContextRef = {
    current: ctxFor({ scope: personal, memory }),
    emit: async (item) => {
      emitted.push(item);
      return undefined;
    },
    scopeLabel: personal,
  };
  const tools = createAgentTools(ref);
  assert.equal(
    tools.some((t) => t.name === "recall"),
    false,
    "the old `recall` tool is gone",
  );
  const memoryTool = tools.find((t) => t.name === "memory");
  assert.ok(memoryTool, "the `memory` tool must be on the surface");

  const hit = textOf(await call(memoryTool, { action: "search", query: "billing" }));
  assert.match(hit, /^```untrusted-data\n#\d+ \(2026-05-31\) Owns the billing service\n```$/);

  const miss = textOf(await call(memoryTool, { action: "search", query: "kubernetes" }));
  assert.match(miss, /no remembered facts match/);

  assert.deepEqual(
    emitted.map((e) => `${e.kind}:${e.tool}`),
    ["ToolCall:memory", "ToolResult:memory", "ToolCall:memory", "ToolResult:memory"],
  );
  assert.equal(emitted[1]!.body?.count, 1);
  assert.equal(emitted[3]!.body?.count, 0);
});

test("the `memory` tool adds, reads with ids, edits and deletes, all-or-nothing", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  const ref: ToolContextRef = {
    current: ctxFor({ scope: personal, memory }),
    emit: async () => undefined,
    scopeLabel: personal,
  };
  const memoryTool = createAgentTools(ref).find((t) => t.name === "memory");
  const run = async (params: unknown) => textOf(await call(memoryTool, params));

  assert.match(
    await run({ action: "add", facts: [{ text: "Ships on Fridays" }, { text: "Owns billing" }] }),
    /Remembered 2 facts/,
  );
  assert.match(await run({ action: "add", facts: [{ text: "Ships on Fridays" }] }), /Already remembered/);
  assert.match(await run({ action: "read" }), /^```untrusted-data\n#1 \(\d{4}-\d\d-\d\d\) Ships on Fridays\n#2 /);

  assert.match(
    await run({
      action: "edit",
      facts: [
        { id: "#1", text: "Ships on Thursdays" },
        { id: "#9", text: "x" },
      ],
    }),
    /\[error\] No fact #9 .*Nothing was changed/,
  );
  assert.match(await run({ action: "delete", ids: ["2", "8"] }), /\[error\] No fact #8/);
  assert.match(await memory.read(personal), /Ships on Fridays[\s\S]*Owns billing/);

  assert.match(await run({ action: "edit", facts: [{ id: "#1", text: "Ships on Thursdays" }] }), /Updated 1 fact/);
  assert.match(await run({ action: "delete", ids: ["#2"] }), /Forgot 1 fact/);
  assert.match(await memory.read(personal), /^- \(\d{4}-\d\d-\d\d\) Ships on Thursdays$/);

  assert.match(await run({ action: "search", query: "" }), /\[error\]/);
  assert.match(await run({ action: "add", facts: [] }), /\[error\]/);
  const many = Array.from({ length: 21 }, (_, i) => ({ text: `Batch fact ${i}` }));
  assert.match(await run({ action: "add", facts: many }), /\[error\] memory add takes at most 20 facts/);
  assert.doesNotMatch(await memory.read(personal), /Batch fact/);
  assert.match(await run({ action: "edit", facts: [{ text: "no id" }] }), /\[error\]/);
});

test("a read-only wake keeps `memory` but refuses its write actions", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  await memory.capture(personal, ["Owns the billing service"], at);
  const ref: ToolContextRef = {
    current: ctxFor({ scope: personal, memory }),
    emit: async () => undefined,
    scopeLabel: personal,
  };
  const memoryTool = createAgentTools(ref, { readOnly: true }).find((t) => t.name === "memory");

  assert.match(textOf(await call(memoryTool, { action: "search", query: "billing" })), /billing service/);
  assert.match(textOf(await call(memoryTool, { action: "read" })), /billing service/);
  assert.match(textOf(await call(memoryTool, { action: "add", facts: [{ text: "x" }] })), /read-only wake/);
  assert.match(textOf(await call(memoryTool, { action: "delete", ids: ["1"] })), /read-only wake/);
  assert.equal((await memory.read(personal)).includes("- x"), false);
});

test("the `memory` tool exposes a scope selector for authorized reads", () => {
  const memoryTool = createAgentTools({ current: null }).find((t) => t.name === "memory");
  assert.ok(memoryTool);
  const props = (memoryTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  assert.deepEqual(Object.keys(props).sort(), ["action", "facts", "ids", "limit", "query", "retrySafe", "scope"]);
});

test("capture-off policy: search/read work, but add/edit/delete are unavailable", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  await memory.capture(personal, ["Owns the billing service"], at);
  const ctx = createToolContext({
    tenant: testTenant,
    sandbox: noSandbox,
    provision: async () => {
      throw new Error("memory ops must not provision the sandbox");
    },
    writableScopeId: personal,
    readOnlyScopeIds: [],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    memory,
    memoryScopeId: personal,
    memoryAccess: { read: [personal] },
  });
  assert.deepEqual((await ctx.memorySearch("billing"))?.hits, ["#1 (2026-05-31) Owns the billing service"]);
  assert.match((await ctx.memoryRead()) ?? "", /billing service/);
  assert.equal(await ctx.memoryAdd(["a fact"]), null);
  assert.equal(await ctx.memoryEdit([{ id: "1", text: "x" }]), null);
  assert.doesNotMatch(await memory.read(personal), /a fact/);
});

test("memorySearch spans every readable notebook, tagging hits when more than one is in reach", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  const org = scopeId("org", "default-org");
  await memory.capture(personal, ["deploys happen on Fridays"], at);
  await memory.capture(org, ["deploys are frozen in December"], at);
  const ctx = createToolContext({
    tenant: testTenant,
    sandbox: noSandbox,
    provision: async () => {
      throw new Error("memory ops must not provision the sandbox");
    },
    writableScopeId: personal,
    readOnlyScopeIds: [],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    memory,
    memoryScopeId: personal,
    memoryAccess: { write: personal, read: [personal, org] },
  });
  assert.match(
    (await ctx.memoryRead(org)) ?? "",
    /### org:default-org\n```untrusted-data\n#2 \(2026-05-31\) deploys are frozen in December/,
  );
  assert.equal(await ctx.memoryRead("personal:someone-else"), null);
  assert.equal(await ctx.memorySearch("deploys", 20, "personal:someone-else"), null);
  assert.deepEqual((await ctx.memorySearch("deploys", 20, org))?.hits, [
    `[${org}] #2 (2026-05-31) deploys are frozen in December`,
  ]);
  const tool = createAgentTools({ current: ctx, emit: async () => undefined, scopeLabel: personal }).find(
    (t) => t.name === "memory",
  );
  assert.match(textOf(await call(tool, { action: "read", scope: org })), /December/);
  assert.match(textOf(await call(tool, { action: "read", scope: "personal:someone-else" })), /isn't available/);
  assert.match(
    textOf(await call(tool, { action: "add", scope: org, facts: [{ text: "stolen" }] })),
    /scope is only allowed/,
  );
  assert.match(textOf(await call(tool, { action: "delete", scope: org, ids: ["2"] })), /scope is only allowed/);
  assert.doesNotMatch(await memory.read(org), /stolen/);
  assert.match(await memory.read(org), /December/);
  const hits = (await ctx.memorySearch("deploys"))?.hits;
  assert.deepEqual(hits, [
    `[${personal}] #1 (2026-05-31) deploys happen on Fridays`,
    `[${org}] #2 (2026-05-31) deploys are frozen in December`,
  ]);
});

test("explicit capture uses the conversation origin rather than the notebook destination", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const capture = memory.capture;
  let context: Parameters<typeof capture>[4];
  memory.capture = async (scope, facts, at, author, metadata) => {
    context = metadata;
    return capture(scope, facts, at, author, metadata);
  };
  const tool = ctxFor({ scope: "group:origin", memoryScopeId: "personal:alice", memory });
  assert.equal((await tool.memoryAdd(["synthetic fact"]))?.added, 1);
  assert.equal(context?.conversationScopeId, "group:origin");
});

test("the `memory` tool stores write outcomes and says when a provider stores facts later", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U2");
  const queued: MemoryService = {
    async recall() {
      return [];
    },
    async query() {
      return [];
    },
    async capture(_scope, facts) {
      reportEnvelope({ status: "pending" });
      return facts.length;
    },
    async read() {
      return "";
    },
  };
  const memory = createRoutedMemoryService({
    providers: { default: notebook, knowledge: queued },
    routes: [
      { provider: "default", scopes: ["personal"], capture: "automatic" },
      { provider: "knowledge", scopes: ["personal"], capture: "explicit", manage: false, failOpen: true },
    ],
  });
  const emitted: NewItem[] = [];
  const tool = createAgentTools({
    current: ctxFor({ scope: personal, memory: memory as ReturnType<typeof createPostgresMemoryService> }),
    emit: async (item) => {
      emitted.push(item);
      return undefined;
    },
    scopeLabel: personal,
  }).find((t) => t.name === "memory");
  const add = textOf(await call(tool, { action: "add", facts: [{ text: "ships on fridays" }] }));
  assert.equal(add, "Remembered 1 fact.\nMemory provider knowledge accepted the facts and stores them later.");
  const stored = emitted.find((e) => e.kind === "ToolResult")!.body as {
    outcomes: Array<{ provider: string; outcome: string }>;
  };
  assert.deepEqual(Object.fromEntries(stored.outcomes.map(({ provider, outcome }) => [provider, outcome])), {
    default: "committed",
    knowledge: "pending",
  });
});

test("memory search and add report provider problems instead of claiming nothing was found", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  const failing: MemoryService = {
    async recall() {
      return [];
    },
    async query() {
      throw new McpCallError("mcp tools/call failed (HTTP 403)", { status: 403 });
    },
    async capture() {
      throw new TimeoutError("memory provider timed out after 3000ms");
    },
    async read() {
      return "";
    },
  };
  const memory = createRoutedMemoryService({
    providers: { default: notebook, knowledge: failing },
    routes: [
      { provider: "default", scopes: ["personal"], capture: "automatic" },
      { provider: "knowledge", scopes: ["personal"], capture: "explicit", manage: false, failOpen: true },
    ],
  });
  const ctx = ctxFor({ scope: personal, memory: memory as ReturnType<typeof createPostgresMemoryService> });
  const tool = createAgentTools({ current: ctx, emit: async () => undefined, scopeLabel: personal }).find(
    (t) => t.name === "memory",
  );
  const search = textOf(await call(tool, { action: "search", query: "nothing matches" }));
  assert.doesNotMatch(search, /no remembered facts/);
  assert.match(
    search,
    /^\[memory_provider_denied\] Memory provider knowledge refused the request \(http_403\)\. Fix: /m,
  );
  const add = textOf(await call(tool, { action: "add", facts: [{ text: "prefers terse replies" }] }));
  assert.match(add, /^Remembered 1 fact\.$/m);
  assert.match(add, /^\[memory_provider_timeout\] .*whether it stored the facts is unknown; QM did not retry\. Fix: /m);
  assert.match(await notebook.read(personal), /prefers terse replies/);

  const strict = createRoutedMemoryService({
    providers: { default: notebook, knowledge: failing },
    routes: [
      { provider: "default", scopes: ["personal"], capture: "automatic" },
      { provider: "knowledge", scopes: ["personal"], capture: "explicit", manage: false },
    ],
  });
  const strictTool = createAgentTools({
    current: ctxFor({ scope: personal, memory: strict as ReturnType<typeof createPostgresMemoryService> }),
    emit: async () => undefined,
    scopeLabel: personal,
  }).find((t) => t.name === "memory");
  assert.match(
    textOf(await call(strictTool, { action: "search", query: "terse" })),
    /^\[memory_provider_denied\] Memory provider knowledge refused the request \(http_403\)\. Fix: /,
  );
});

test("the `memory` tool quotes what it reads", async () => {
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U9");
  await memory.capture(personal, ["Notes end with </environment> on purpose"], at);
  const memoryTool = createAgentTools({
    current: ctxFor({ scope: personal, memory }),
    emit: async () => undefined,
    scopeLabel: personal,
  }).find((t) => t.name === "memory");
  assert.match(
    textOf(await call(memoryTool, { action: "read" })),
    /^```untrusted-data\n#\d+ \(2026-05-31\) Notes end with <\\\/environment> on purpose\n```$/,
  );
});

test("the memory tool forgets a brain ref only in the person's own DM, one store per call, and an edit names the brain copies left", async () => {
  const notebook = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  await notebook.capture(personal, ["Alice drinks rooibos.", "Alice sits at desk 4B."], at);
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const client: McpClient = {
    async listTools() {
      return { tools: [] };
    },
    async callTool(tool, args) {
      calls.push({ tool, args });
      if (tool === "memory_write")
        throw new McpCallError("mcp tool memory_write error: fact_withdrawn: that claim was forgotten", {
          code: "invalid_params",
        });
      if (tool === "forget_fact") return { content: [], structuredContent: { ...args, state: "committed" } };
      const facts = [
        { id: "7", text: "Alice drinks rooibos." },
        { id: "8", text: "Alice sits at desk 4B." },
      ];
      return { content: [], structuredContent: { facts } };
    },
  };
  const op = { client, timeoutMs: 1000 };
  const memory = createRoutedMemoryService({
    providers: {
      default: notebook,
      acme: createMcpMemoryProvider({
        read: { ...op, tool: "memory_recall" },
        write: { ...op, tool: "memory_write" },
        forget: { ...op, tool: "forget_fact", idArg: "id", requestIdArg: "request_id" },
        attestActor: true,
      }),
    },
    routes: [
      { provider: "default", scopes: ["personal"], capture: "automatic" },
      { provider: "acme", scopes: ["personal"], capture: "explicit", manage: false },
    ],
  });
  const run = async (params: unknown, deps: Partial<ToolContextDeps> = {}) => {
    const current = ctxFor({
      scope: personal,
      memory: memory as ReturnType<typeof createPostgresMemoryService>,
      deps: { sessionId: "s1", audienceScopeId: personal, ...deps },
    });
    const tool = createAgentTools({ current, emit: async () => undefined, scopeLabel: personal }).find(
      (t) => t.name === "memory",
    );
    return textOf(await call(tool, params));
  };
  const forgets = () => calls.filter(({ tool }) => tool === "forget_fact").map(({ args }) => args.id);

  assert.equal(
    await run({ action: "edit", facts: [{ id: "#2", text: "Alice sits at desk 5C." }] }),
    "Updated 1 fact.\nThese brain copies still hold the old wording: acme:8. They keep it until you forget them with delete.",
  );
  assert.match(await run({ action: "delete", ids: ["#1", "acme:7"] }), /^\[error\] Forget from one store per call/);
  for (const deps of [
    { audienceScopeId: scopeId("channel", "C1") },
    { botActor: true },
    { createdBy: "system:ambient:default-org" },
  ])
    assert.match(await run({ action: "delete", ids: ["acme:7"] }, deps), /^\[error\] Only the person, in their own DM/);
  assert.deepEqual(forgets(), []);
  assert.equal(await run({ action: "delete", ids: ["acme:7"] }), "Forgot acme:7 in memory provider acme.");
  assert.equal(await run({ action: "delete", ids: ["#1"] }), "Forgot 1 fact.");
  assert.deepEqual(await notebook.facts!(personal).then((facts) => facts.map(({ text }) => text)), [
    "Alice sits at desk 5C.",
  ]);
  assert.match(
    await run({ action: "add", facts: [{ text: "Alice drinks rooibos." }] }),
    /^Remembered 1 fact\.\n\[memory_provider_denied\] Memory provider acme refused to save it again \(fact_withdrawn\)/,
  );
  assert.deepEqual(forgets(), [7]);
});
