import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpMemoryProvider } from "../src/memory/mcp-memory-provider.ts";
import type { McpClient } from "../src/mcp/mcp-client.ts";

type Call = { tool: string; args: Record<string, unknown>; timeoutMs?: number | undefined };

function client(calls: Call[], text = "result"): McpClient {
  return {
    host: "knowledge.internal",
    async listTools() {
      return [];
    },
    async callTool(tool, args, options) {
      calls.push({ tool, args, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
      return { content: [{ type: "text", text }] };
    },
    async close() {},
  };
}

test("MCP provider passes query, actor, and explicit writes through configured tools", async () => {
  const calls: Call[] = [];
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
  assert.equal(await memory.recall("org:acme", { query: "launch", actorId: "u1", maxChars: 2000 }), "result");
  assert.equal(await memory.capture("org:acme", ["decision"], 10, "u1", { mode: "explicit", actorId: "u1" }), 1);
  assert.deepEqual(calls, [
    {
      tool: "search_knowledge",
      args: { query: "launch", acting_user: "u1", namespace: "org:acme", max_chars: 2000 },
      timeoutMs: 100,
    },
    {
      tool: "write_knowledge",
      args: { content: "decision", captured_at: 10, source: "explicit", acting_user: "u1", namespace: "org:acme" },
      timeoutMs: 100,
    },
  ]);
});

test("MCP recall is locally bounded", async () => {
  const bounded = createMcpMemoryProvider({
    read: { client: client([], "abcdefgh"), tool: "read", timeoutMs: 100 },
  });
  assert.equal(await bounded.recall("org:acme", { maxChars: 4 }), "abcd");
});
