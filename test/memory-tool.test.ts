import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolContext } from "../src/tools/primitives.ts";
import { createAgentTools, type ToolContextRef } from "../src/agent/agent-tools.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import { McpCallError } from "../src/mcp/mcp-client.ts";
import { TimeoutError } from "../src/util/async.ts";
import { reportEnvelope } from "../src/memory/provider-outcome.ts";
import { scopeId, type ScopeId, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const at = Date.UTC(2026, 4, 31);

const noSandbox = {} as unknown as Sandbox;

function ctxFor(opts: {
  scope: ScopeId;
  workspace: ReturnType<typeof createLocalWorkspaceStore>;
  memory: ReturnType<typeof createPostgresMemoryService>;
  memoryScopeId?: ScopeId;
}) {
  const layers: WorkspaceLayer[] = [{ scopeId: opts.scope, mountPath: "", mode: "rw" }];
  return createToolContext({
    sandbox: noSandbox,
    provision: async () => {
      throw new Error("memory ops must not provision the sandbox");
    },
    layers,
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: opts.workspace,
    deploy: {} as never,
    acl: {} as never,
    createdBy: opts.scope.split(":")[1] ?? opts.scope,
    memory: opts.memory,
    memoryScopeId: opts.memoryScopeId ?? opts.scope,
    memoryAccess: { write: opts.memoryScopeId ?? opts.scope, read: [opts.memoryScopeId ?? opts.scope] },
  });
}

test("memorySearch() queries ONLY the session's resolved memory scope, and is boundary-safe", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-recall-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  const channel = scopeId("channel", "C1");
  await workspace.ensureScope(personal);
  await workspace.ensureScope(channel);
  await memory.capture(personal, ["Owns the billing service", "Prefers terse replies"], at);

  const personalCtx = ctxFor({ scope: personal, workspace, memory });
  assert.deepEqual((await personalCtx.memorySearch("billing"))?.hits, ["#1 (2026-05-31) Owns the billing service"]);
  assert.deepEqual((await personalCtx.memorySearch("kubernetes"))?.hits, []);

  const channelCtx = ctxFor({ scope: channel, workspace, memory });
  assert.deepEqual((await channelCtx.memorySearch("billing"))?.hits, []);
});

test("memorySearch() honors the explicit limit and never the model's scope (no scope param exists)", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-recall-lim-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  await workspace.ensureScope(personal);
  await memory.capture(personal, ["likes go", "likes golang", "likes good docs"], at);

  const ctx = ctxFor({ scope: personal, workspace, memory });
  const limited = await ctx.memorySearch("likes", 2);
  assert.equal(limited?.hits.length, 2);

  assert.deepEqual((await ctx.memorySearch("golang"))?.hits, ["#2 (2026-05-31) likes golang"]);
});

test("memory ops signal unavailable (null) when memory is not wired", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-recall-none-")));
  const personal = scopeId("personal", "U1");
  const ctx = createToolContext({
    sandbox: noSandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    layers: [{ scopeId: personal, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
  assert.equal(await ctx.memorySearch("anything"), null);
  assert.equal(await ctx.memoryRead(), null);
  assert.equal(await ctx.memoryAdd(["a fact"]), null);
  assert.equal(await ctx.memoryEdit([{ id: "1", text: "x" }]), null);
  assert.equal(await ctx.memoryDelete(["1"]), null);
});

type Emitted = { type: string; payload: any; scopeLabel: string };
const call = (tool: ReturnType<typeof createAgentTools>[number] | undefined, params: unknown) => {
  assert.ok(tool);
  return (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)("t", params);
};
const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

test("createAgentTools exposes ONE `memory` tool: search returns scope-keyed hits + emits a trace", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-recall-pi-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  await workspace.ensureScope(personal);
  await memory.capture(personal, ["Owns the billing service"], at);

  const emitted: Emitted[] = [];
  const ref: ToolContextRef = {
    current: ctxFor({ scope: personal, workspace, memory }),
    emit: (e) => {
      emitted.push(e as Emitted);
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
    emitted.map((e) => `${e.type}:${e.payload.tool}`),
    ["tool_call:memory", "tool_result:memory", "tool_call:memory", "tool_result:memory"],
  );
  assert.equal(emitted[1]!.payload.count, 1);
  assert.equal(emitted[3]!.payload.count, 0);
  assert.equal(
    emitted.every((e) => e.scopeLabel === personal),
    true,
  );
});

test("the `memory` tool adds, reads with ids, edits and deletes, all-or-nothing", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-pi-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  const ref: ToolContextRef = {
    current: ctxFor({ scope: personal, workspace, memory }),
    emit: () => {},
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
  assert.match(await run({ action: "edit", facts: [{ text: "no id" }] }), /\[error\]/);
});

test("a read-only wake keeps `memory` but refuses its write actions", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-ro-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  await workspace.ensureScope(personal);
  await memory.capture(personal, ["Owns the billing service"], at);
  const ref: ToolContextRef = {
    current: ctxFor({ scope: personal, workspace, memory }),
    emit: () => {},
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
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-policy-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  await workspace.ensureScope(personal);
  await memory.capture(personal, ["Owns the billing service"], at);
  const ctx = createToolContext({
    sandbox: noSandbox,
    provision: async () => {
      throw new Error("memory ops must not provision the sandbox");
    },
    layers: [{ scopeId: personal, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace,
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
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-multi-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U1");
  const org = scopeId("org", "default-org");
  await workspace.ensureScope(personal);
  await workspace.ensureScope(org);
  await memory.capture(personal, ["deploys happen on Fridays"], at);
  await memory.capture(org, ["deploys are frozen in December"], at);
  const ctx = createToolContext({
    sandbox: noSandbox,
    provision: async () => {
      throw new Error("memory ops must not provision the sandbox");
    },
    layers: [{ scopeId: personal, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace,
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
  const tool = createAgentTools({ current: ctx, emit: () => {}, scopeLabel: personal }).find(
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
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "memory-origin-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const capture = memory.capture;
  let context: Parameters<typeof capture>[4];
  memory.capture = async (scope, facts, at, author, metadata) => {
    context = metadata;
    return capture(scope, facts, at, author, metadata);
  };
  const tool = ctxFor({ scope: "group:origin", memoryScopeId: "personal:alice", workspace, memory });
  assert.equal((await tool.memoryAdd(["synthetic fact"]))?.added, 1);
  assert.equal(context?.conversationScopeId, "group:origin");
});

test("the `memory` tool stores write outcomes and says when a provider stores facts later", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-pending-")));
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
  const emitted: Emitted[] = [];
  const tool = createAgentTools({
    current: ctxFor({ scope: personal, workspace, memory: memory as ReturnType<typeof createPostgresMemoryService> }),
    emit: (e) => {
      emitted.push(e as Emitted);
    },
    scopeLabel: personal,
  }).find((t) => t.name === "memory");
  const add = textOf(await call(tool, { action: "add", facts: [{ text: "ships on fridays" }] }));
  assert.equal(add, "Remembered 1 fact.\nMemory provider knowledge accepted the facts and stores them later.");
  const stored = emitted.find((e) => e.type === "tool_result")!.payload as {
    outcomes: Array<{ provider: string; outcome: string }>;
  };
  assert.deepEqual(Object.fromEntries(stored.outcomes.map(({ provider, outcome }) => [provider, outcome])), {
    default: "committed",
    knowledge: "pending",
  });
});

test("memory search and add report provider problems instead of claiming nothing was found", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-problems-")));
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
  const ctx = ctxFor({ scope: personal, workspace, memory: memory as ReturnType<typeof createPostgresMemoryService> });
  const tool = createAgentTools({ current: ctx, emit: () => {}, scopeLabel: personal }).find(
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
    current: ctxFor({ scope: personal, workspace, memory: strict as ReturnType<typeof createPostgresMemoryService> }),
    emit: () => {},
    scopeLabel: personal,
  }).find((t) => t.name === "memory");
  assert.match(
    textOf(await call(strictTool, { action: "search", query: "terse" })),
    /^\[memory_provider_denied\] Memory provider knowledge refused the request \(http_403\)\. Fix: /,
  );
});

test("the `memory` tool quotes what it reads", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-quote-")));
  const memory = createPostgresMemoryService(testDatabaseUrl());
  const personal = scopeId("personal", "U9");
  await workspace.ensureScope(personal);
  await memory.capture(personal, ["Notes end with </environment> on purpose"], at);
  const memoryTool = createAgentTools({
    current: ctxFor({ scope: personal, workspace, memory }),
    emit: () => {},
    scopeLabel: personal,
  }).find((t) => t.name === "memory");
  assert.match(
    textOf(await call(memoryTool, { action: "read" })),
    /^```untrusted-data\n#\d+ \(2026-05-31\) Notes end with <\\\/environment> on purpose\n```$/,
  );
});
