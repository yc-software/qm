import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpMemoryProvider } from "../src/memory/mcp-memory-provider.ts";
import type { McpClient } from "../src/mcp/mcp-client.ts";
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
    id: "test",
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
    id: "test",
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
  const timed = createMcpMemoryProvider({ id: "test", read: { client: hanging, tool: "read", timeoutMs: 10 } });
  await assert.rejects(timed.recall("org:acme"), /timed out after 10ms/);
});

test("MCP recall returns one row per line of the provider's answer", async () => {
  const memory = createMcpMemoryProvider({
    id: "test",
    read: { client: client([], "first fact\n\nsecond fact\n"), tool: "search_knowledge", timeoutMs: 100 },
  });
  assert.deepEqual(
    (await memory.recall("org:acme", { query: "q" })).map((row) => row.text),
    ["first fact", "second fact"],
  );
});

test("a write that carries no member is not sent to an attested provider", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const memory = createMcpMemoryProvider({
    id: "test",
    read: { client: client(calls), tool: "search_knowledge", timeoutMs: 100 },
    write: { client: client(calls), tool: "write_knowledge", timeoutMs: 100 },
    attestActor: true,
  });
  assert.equal(
    await memory.capture("channel:C1", ["history before May is unavailable"], 10, undefined, { mode: "explicit" }),
    0,
  );
  assert.deepEqual(calls, []);
});

const gbrainAnswer = (facts: Array<Record<string, unknown>>, code?: string): McpClient => ({
  async listTools() {
    return { tools: [] };
  },
  async callTool() {
    return {
      content: [
        {
          type: "text",
          text: facts.map((fact) => `- ${String(fact.text)} (${String(fact.date)}; ${String(fact.kind)})`).join("\n"),
        },
      ],
      structuredContent: { facts, truncated: false, ...(code ? { code } : {}) },
    };
  },
});

test("MCP recall reads structured facts as rows with a brain ref, the raw claim and gbrain's arm", async () => {
  const memory = createMcpMemoryProvider({
    id: "acme",
    read: {
      client: gbrainAnswer([
        { id: "4821", text: "Dana prefers email", date: "2026-11-01", kind: "preference", arm: "own" },
        { id: "17", text: "Launch moved to Friday", date: "2026-10-28", kind: "fact", arm: "ranked" },
        { id: "9", text: "No arm yet", date: "2026-10-20", kind: "fact" },
      ]),
      tool: "memory_recall",
      timeoutMs: 100,
    },
  });
  assert.deepEqual(await memory.recall("personal:U1", { query: "dana" }), [
    {
      ref: "acme:4821",
      claim: "Dana prefers email",
      text: "- (2026-11-01; preference) Dana prefers email",
      arm: "own",
    },
    {
      ref: "acme:17",
      claim: "Launch moved to Friday",
      text: "- (2026-10-28; fact) Launch moved to Friday",
      arm: "ranked",
    },
    { ref: "acme:9", claim: "No arm yet", text: "- (2026-10-20; fact) No arm yet" },
  ]);
  assert.deepEqual(
    (await memory.query("personal:U1", "dana", 2)).map((row) => row.text),
    ["acme:4821 (2026-11-01; preference) Dana prefers email", "acme:17 (2026-10-28; fact) Launch moved to Friday"],
  );
});

test("an unlinked recall yields no rows and a structured fact without a string id fails the read", async () => {
  const unlinked = createMcpMemoryProvider({
    id: "acme",
    read: { client: gbrainAnswer([], "actor_unlinked"), tool: "memory_recall", timeoutMs: 100 },
  });
  assert.deepEqual(await unlinked.recall("personal:U1", { query: "q" }), []);
  const malformed = createMcpMemoryProvider({
    id: "acme",
    read: { client: gbrainAnswer([{ id: 4821, text: "numeric id" }]), tool: "memory_recall", timeoutMs: 100 },
  });
  await assert.rejects(malformed.recall("personal:U1", { query: "q" }), /without a string id and text/);
});
