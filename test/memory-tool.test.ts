import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolContext } from "../src/tools/primitives.ts";
import { createPiTools, type ToolContextRef } from "../src/harness/pi-tools.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { scopeId, type ScopeId, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const at = Date.UTC(2026, 4, 31);

const noSandbox = {} as unknown as Sandbox;

function ctxFor(opts: {
  scope: ScopeId;
  workspace: ReturnType<typeof createLocalWorkspaceStore>;
  memory: ReturnType<typeof createMemoryService>;
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
  const memory = createMemoryService(workspace);
  const personal = scopeId("personal", "U1");
  const channel = scopeId("channel", "C1");
  await workspace.ensureScope(personal);
  await workspace.ensureScope(channel);
  await memory.capture(personal, ["Owns the billing service", "Prefers terse replies"], at);

  const personalCtx = ctxFor({ scope: personal, workspace, memory });
  assert.deepEqual(await personalCtx.memorySearch("billing"), ["(2026-05-31) Owns the billing service"]);
  assert.deepEqual(await personalCtx.memorySearch("kubernetes"), []);

  const channelCtx = ctxFor({ scope: channel, workspace, memory });
  assert.deepEqual(await channelCtx.memorySearch("billing"), []);
});

test("memorySearch() honors the explicit limit and never the model's scope (no scope param exists)", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-recall-lim-")));
  const memory = createMemoryService(workspace);
  const personal = scopeId("personal", "U1");
  await workspace.ensureScope(personal);
  await memory.capture(personal, ["likes go", "likes golang", "likes good docs"], at);

  const ctx = ctxFor({ scope: personal, workspace, memory });
  const limited = await ctx.memorySearch("likes", 2);
  assert.equal(limited?.length, 2);

  assert.deepEqual(await ctx.memorySearch("golang"), ["(2026-05-31) likes golang"]);
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
  assert.equal(await ctx.memoryRemember(["a fact"]), null);
  assert.equal(await ctx.memoryRewrite("# Memory\n"), null);
});

test("memoryRemember/memoryRead/memoryRewrite hit the durable MemoryService, attributed to the actor", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-write-")));
  const memory = createMemoryService(workspace);
  const personal = scopeId("personal", "U1");
  await workspace.ensureScope(personal);
  const ctx = ctxFor({ scope: personal, workspace, memory });

  assert.equal(await ctx.memoryRemember(["Prefers terse replies"]), 1);
  assert.equal(await ctx.memoryRemember(["Prefers terse replies"]), 0, "duplicates are dropped");
  assert.match((await ctx.memoryRead()) ?? "", /Prefers terse replies/);

  assert.equal(await ctx.memoryRewrite("# Memory\n\n- I work in PT\n"), true);
  const body = (await ctx.memoryRead()) ?? "";
  assert.match(body, /I work in PT/);
  assert.doesNotMatch(body, /terse replies/, "rewrite replaces the whole notebook");
});

type Emitted = { type: string; payload: any; scopeLabel: string };
const call = (tool: ReturnType<typeof createPiTools>[number] | undefined, params: unknown) => {
  assert.ok(tool);
  return (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)("t", params);
};
const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";

test("createPiTools exposes ONE `memory` tool: search returns scope-keyed hits + emits a trace", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-recall-pi-")));
  const memory = createMemoryService(workspace);
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
  const tools = createPiTools(ref);
  assert.equal(
    tools.some((t) => t.name === "recall"),
    false,
    "the old `recall` tool is gone",
  );
  const memoryTool = tools.find((t) => t.name === "memory");
  assert.ok(memoryTool, "the `memory` tool must be on the surface");

  const hit = textOf(await call(memoryTool, { action: "search", query: "billing" }));
  assert.match(hit, /billing service/);

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

test("the `memory` tool remember/read/rewrite round-trip through the durable service", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-pi-")));
  const memory = createMemoryService(workspace);
  const personal = scopeId("personal", "U1");
  await workspace.ensureScope(personal);
  const ref: ToolContextRef = {
    current: ctxFor({ scope: personal, workspace, memory }),
    emit: () => {},
    scopeLabel: personal,
  };
  const memoryTool = createPiTools(ref).find((t) => t.name === "memory");

  assert.match(
    textOf(await call(memoryTool, { action: "remember", facts: ["Ships on Fridays"] })),
    /Remembered 1 fact/,
  );
  assert.match(
    textOf(await call(memoryTool, { action: "remember", facts: ["Ships on Fridays"] })),
    /Already remembered/,
  );
  assert.match(textOf(await call(memoryTool, { action: "read" })), /Ships on Fridays/);
  assert.match(
    textOf(await call(memoryTool, { action: "rewrite", content: "# Memory\n\n- Renamed fact\n" })),
    /Rewrote/,
  );
  assert.match(await memory.read(personal), /Renamed fact/);

  assert.match(textOf(await call(memoryTool, { action: "search", query: "" })), /\[error\]/);
  assert.match(textOf(await call(memoryTool, { action: "remember", facts: [] })), /\[error\]/);
  assert.match(textOf(await call(memoryTool, { action: "rewrite" })), /\[error\]/);
});

test("a read-only wake keeps `memory` but refuses its write actions", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-ro-")));
  const memory = createMemoryService(workspace);
  const personal = scopeId("personal", "U1");
  await workspace.ensureScope(personal);
  await memory.capture(personal, ["Owns the billing service"], at);
  const ref: ToolContextRef = {
    current: ctxFor({ scope: personal, workspace, memory }),
    emit: () => {},
    scopeLabel: personal,
  };
  const memoryTool = createPiTools(ref, { readOnly: true }).find((t) => t.name === "memory");

  assert.match(textOf(await call(memoryTool, { action: "search", query: "billing" })), /billing service/);
  assert.match(textOf(await call(memoryTool, { action: "read" })), /billing service/);
  assert.match(textOf(await call(memoryTool, { action: "remember", facts: ["x"] })), /read-only wake/);
  assert.match(textOf(await call(memoryTool, { action: "rewrite", content: "" })), /read-only wake/);
  assert.equal((await memory.read(personal)).includes("- x"), false);
});

test("the `memory` tool params expose NO scope field — the model cannot redirect the notebook", () => {
  const memoryTool = createPiTools({ current: null }).find((t) => t.name === "memory");
  assert.ok(memoryTool);
  const props = (memoryTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  assert.deepEqual(Object.keys(props).sort(), ["action", "content", "facts", "limit", "query"]);
  assert.equal("scope" in props, false);
});

test("capture-off policy: search still works, but read/remember/rewrite are unavailable (mirrors the self-API claim)", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-policy-")));
  const memory = createMemoryService(workspace);
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
  assert.deepEqual(await ctx.memorySearch("billing"), ["(2026-05-31) Owns the billing service"]);
  assert.equal(await ctx.memoryRead(), null);
  assert.equal(await ctx.memoryRemember(["a fact"]), null);
  assert.equal(await ctx.memoryRewrite("# Memory\n"), null);
  assert.doesNotMatch(await memory.read(personal), /a fact/);
});

test("memorySearch spans every readable notebook, tagging hits when more than one is in reach", async () => {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ws-mem-multi-")));
  const memory = createMemoryService(workspace);
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
  const hits = await ctx.memorySearch("deploys");
  assert.deepEqual(hits, [
    `[${personal}] (2026-05-31) deploys happen on Fridays`,
    `[${org}] (2026-05-31) deploys are frozen in December`,
  ]);
});
