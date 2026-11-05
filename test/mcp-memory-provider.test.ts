import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpMemoryProvider } from "../src/memory/mcp-memory-provider.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import type { McpClient } from "../src/mcp/mcp-client.ts";
import type { MemoryProviderOutcome } from "../src/memory/memory-service.ts";
import { sleep } from "../src/util/async.ts";
import { recallText } from "./support/recall-text.ts";

function client(calls: Array<{ tool: string; args: Record<string, unknown> }>, text = "result"): McpClient {
  return {
    async listTools() {
      return { tools: [] };
    },
    async callTool(tool, args) {
      calls.push({ tool, args });
      return { content: [{ type: "text", text }] };
    },
  };
}

test("MCP provider passes query, actor, and explicit writes through configured tools", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const memory = createMcpMemoryProvider({
    read: {
      client: client(calls),
      tool: "search_knowledge",
      timeoutMs: 100,
      scopeArg: "namespace",
      maxCharsArg: "max_chars",
    },
    write: {
      client: client(calls),
      tool: "write_knowledge",
      timeoutMs: 100,
      scopeArg: "namespace",
      capturedAtArg: "captured_at",
      sourceArg: "source",
    },
  });
  assert.equal(
    recallText(await memory.recall("org:acme", { query: "launch", actorId: "u1", maxChars: 2000 })),
    "result",
  );
  assert.equal(await memory.capture("org:acme", ["decision"], 10, "u1", { mode: "explicit", actorId: "u1" }), 1);
  assert.deepEqual(calls, [
    { tool: "search_knowledge", args: { query: "launch", acting_user: "u1", namespace: "org:acme", max_chars: 2000 } },
    {
      tool: "write_knowledge",
      args: { content: "decision", captured_at: 10, source: "explicit", acting_user: "u1", namespace: "org:acme" },
    },
  ]);
});

test("MCP recall is locally bounded and times out", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const bounded = createMcpMemoryProvider({
    read: { client: client(calls, "abcdefgh"), tool: "read", timeoutMs: 100 },
  });
  assert.equal(recallText(await bounded.recall("org:acme", { maxChars: 4 })), "abcd");

  const hanging: McpClient = {
    async listTools() {
      return { tools: [] };
    },
    async callTool() {
      return new Promise(() => {});
    },
  };
  const timed = createMcpMemoryProvider({ read: { client: hanging, tool: "read", timeoutMs: 10 } });
  await assert.rejects(timed.recall("org:acme"), /timed out after 10ms/);
});

test("MCP recall returns one row per line of the provider's answer", async () => {
  const memory = createMcpMemoryProvider({
    read: { client: client([], "first fact\n\nsecond fact\n"), tool: "search_knowledge", timeoutMs: 100 },
  });
  assert.deepEqual(
    (await memory.recall("org:acme", { query: "q" })).map((row) => row.text),
    ["first fact", "second fact"],
  );
});

test("a write that carries no member is not sent to an attested provider", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const memory = createRoutedMemoryService({
    providers: {
      knowledge: createMcpMemoryProvider({
        read: { client: client(calls), tool: "search_knowledge", timeoutMs: 100 },
        write: { client: client(calls), tool: "write_knowledge", timeoutMs: 100 },
        attestActor: true,
      }),
    },
    routes: [{ provider: "knowledge", scopes: ["channel"], capture: "explicit", manage: false }],
  });
  assert.equal(
    await memory.capture("channel:C1", ["history before May is unavailable"], 10, undefined, { mode: "explicit" }),
    0,
  );
  assert.deepEqual(calls, []);
});

function answering(answer: () => Promise<Record<string, unknown>>): McpClient {
  return {
    async listTools() {
      return { tools: [] };
    },
    async callTool() {
      return { content: [], structuredContent: await answer() };
    },
  };
}

const facts = (count: number) => Array.from({ length: count }, (_, i) => `fact ${i + 1}`);

test("a write split into batches carries the turn's input and reply once", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const memory = createMcpMemoryProvider({
    read: { client: client(calls), tool: "search_knowledge", timeoutMs: 100 },
    write: {
      client: client(calls),
      tool: "write_knowledge",
      timeoutMs: 100,
      factsArg: "facts",
      inputArg: "input",
      replyArg: "reply",
    },
  });
  const context = { mode: "automatic" as const, actorId: "u1", input: "my seats", reply: "noted" };
  assert.equal(await memory.capture("org:acme", facts(45), 10, "u1", context), 45);
  assert.deepEqual(
    calls.map(({ args }) => [(args.facts as unknown[]).length, args.input, args.reply]),
    [
      [20, "my seats", "noted"],
      [20, undefined, undefined],
      [5, undefined, undefined],
    ],
  );
});

test("every batch of a split write shares the write's one deadline", async () => {
  const slow = answering(async () => {
    await sleep(100);
    return { status: "committed" };
  });
  const memory = createMcpMemoryProvider({
    read: { client: slow, tool: "read", timeoutMs: 250 },
    write: { client: slow, tool: "write", timeoutMs: 250, factsArg: "facts" },
  });
  await assert.rejects(
    memory.capture("org:acme", facts(60), 10, "u1", { mode: "automatic", actorId: "u1" }),
    /timed out/,
  );
});

test("a split write is pending when any of its batches is, with its last batch's code", async () => {
  let calls = 0;
  const queued = answering(async () =>
    ++calls === 1 ? { status: "pending", code: "queued" } : { status: "committed" },
  );
  const outcomes: MemoryProviderOutcome[] = [];
  const memory = createRoutedMemoryService({
    providers: {
      knowledge: createMcpMemoryProvider({
        read: { client: queued, tool: "read", timeoutMs: 100 },
        write: { client: queued, tool: "write", timeoutMs: 100, factsArg: "facts" },
      }),
    },
    routes: [{ provider: "knowledge", scopes: ["org"], capture: "explicit", manage: false }],
  });
  await memory.capture("org:acme", facts(21), 10, "u1", {
    mode: "explicit",
    actorId: "u1",
    report: (outcome) => void outcomes.push(outcome),
  });
  assert.equal(calls, 2);
  assert.deepEqual(
    outcomes.map(({ outcome, code }) => ({ outcome, code })),
    [{ outcome: "pending", code: undefined }],
  );
});

test("a split write sends no batch once its deadline has passed", async () => {
  let calls = 0;
  const blocking: McpClient = {
    async listTools() {
      return { tools: [] };
    },
    callTool() {
      calls++;
      const until = Date.now() + 70;
      while (Date.now() < until);
      return Promise.resolve({ content: [], structuredContent: { status: "committed" } });
    },
  };
  const memory = createMcpMemoryProvider({
    read: { client: blocking, tool: "read", timeoutMs: 100 },
    write: { client: blocking, tool: "write", timeoutMs: 100, factsArg: "facts" },
  });
  await assert.rejects(
    memory.capture("org:acme", facts(60), 10, "u1", { mode: "automatic", actorId: "u1" }),
    /timed out after 100ms/,
  );
  assert.equal(calls, 2);
});
