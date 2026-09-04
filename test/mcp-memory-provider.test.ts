import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpMemoryProvider } from "../src/memory/mcp-memory-provider.ts";
import type { McpClient } from "../src/mcp/mcp-client.ts";

function client(calls: Array<{ tool: string; args: Record<string, unknown> }>, text = "result"): McpClient {
  return {
    base: "http://brain.internal",
    host: "brain.internal",
    async listTools() {
      return [];
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
      tool: "read_brain",
      timeoutMs: 100,
      scopeArg: "namespace",
      maxCharsArg: "max_chars",
    },
    write: {
      client: client(calls),
      tool: "write_brain",
      timeoutMs: 100,
      scopeArg: "namespace",
      capturedAtArg: "captured_at",
      sourceArg: "source",
    },
  });
  assert.equal(await memory.recall("org:yc", { query: "launch", actorId: "u1", maxChars: 2000 }), "result");
  assert.equal(await memory.capture("org:yc", ["decision"], 10, "u1", { mode: "explicit", actorId: "u1" }), 1);
  assert.deepEqual(calls, [
    { tool: "read_brain", args: { query: "launch", acting_user: "u1", namespace: "org:yc", max_chars: 2000 } },
    {
      tool: "write_brain",
      args: { content: "decision", captured_at: 10, source: "explicit", acting_user: "u1", namespace: "org:yc" },
    },
  ]);
});

test("MCP recall is locally bounded and times out", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const bounded = createMcpMemoryProvider({
    read: { client: client(calls, "abcdefgh"), tool: "read", timeoutMs: 100 },
  });
  assert.equal(await bounded.recall("org:yc", { maxChars: 4 }), "abcd");

  const hanging: McpClient = {
    base: "http://brain.internal",
    host: "brain.internal",
    async listTools() {
      return [];
    },
    async callTool() {
      return new Promise(() => {});
    },
  };
  const timed = createMcpMemoryProvider({ read: { client: hanging, tool: "read", timeoutMs: 10 } });
  await assert.rejects(timed.recall("org:yc"), /timed out after 10ms/);
});
