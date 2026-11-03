import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpMemoryProvider } from "../src/memory/mcp-memory-provider.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import type { MemoryProviderOutcome } from "../src/memory/memory-service.ts";
import { McpCallError, type McpClient } from "../src/mcp/mcp-client.ts";
import { recallText } from "./support/recall-text.ts";
import { structuredRecall } from "./support/structured-recall.ts";

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
  assert.equal(
    await memory.capture(
      "org:acme",
      ["decision"],
      10,
      { actorId: "u1", context: "conversation" },
      { mode: "explicit" },
    ),
    1,
  );
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
  const memory = createMcpMemoryProvider({
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

test("MCP recall reads structured facts as rows with their fact id and raw claim, in the provider's order", async () => {
  const facts = [
    { id: "4821", text: "Dana prefers email", date: "2026-11-01", kind: "preference" },
    { id: "17", text: "Launch moved to Friday", date: "2026-10-28", kind: "fact" },
    { id: "9", text: "Undated fact" },
    { id: "4822", text: "Standup moved to 9", date: "2026-11-01", kind: "fact" },
  ];
  const memory = createMcpMemoryProvider({
    read: { client: structuredRecall(() => facts), tool: "memory_recall", timeoutMs: 100 },
  });
  const recalled = await memory.recall("personal:U1", { query: "dana" });
  assert.deepEqual(recalled, [
    { ref: "4821", claim: "Dana prefers email", text: "- (2026-11-01; preference) Dana prefers email" },
    { ref: "17", claim: "Launch moved to Friday", text: "- (2026-10-28; fact) Launch moved to Friday" },
    { ref: "9", claim: "Undated fact", text: "- Undated fact" },
    { ref: "4822", claim: "Standup moved to 9", text: "- (2026-11-01; fact) Standup moved to 9" },
  ]);
  const fit = recalled[0]!.text.length + 1 + recalled[1]!.text.length;
  assert.deepEqual(
    (await memory.recall("personal:U1", { query: "dana", maxChars: fit })).map((row) => row.ref),
    ["4821", "17"],
  );
  assert.deepEqual(
    (await memory.recall("personal:U1", { query: "dana", maxChars: 5 })).map((row) => row.ref),
    ["4821"],
  );
  assert.deepEqual(
    (await memory.query("personal:U1", "dana", 2)).map((row) => row.text),
    ["(2026-11-01; preference) Dana prefers email", "(2026-10-28; fact) Launch moved to Friday"],
  );
});

test("a refused recall yields no rows even with facts attached, and a malformed fact fails as malformed_fact", async () => {
  const unlinked = createMcpMemoryProvider({
    read: {
      client: structuredRecall(() => [{ id: "1", text: "never shown" }], "actor_unlinked"),
      tool: "memory_recall",
      timeoutMs: 100,
    },
  });
  assert.deepEqual(await unlinked.recall("personal:U1", { query: "q" }), []);
  const answering = (facts: unknown) =>
    createMcpMemoryProvider({
      read: {
        client: {
          async listTools() {
            return { tools: [] };
          },
          async callTool() {
            return { content: [{ type: "text", text: "x" }], structuredContent: { facts } };
          },
        },
        tool: "memory_recall",
        timeoutMs: 100,
      },
    });
  await assert.rejects(
    answering("x").recall("personal:U1", { query: "q" }),
    (error) => error instanceof McpCallError && error.code === "malformed_fact",
  );
  const outcomes: MemoryProviderOutcome[] = [];
  const routed = createRoutedMemoryService({
    providers: { default: answering([]), acme: answering([{ id: 4821, text: "numeric id" }]) },
    routes: [
      { provider: "default", scopes: ["personal"] },
      { provider: "acme", scopes: ["personal"], manage: false, failOpen: true },
    ],
  });
  assert.deepEqual(await routed.recall("personal:U1", { query: "q", report: (o) => void outcomes.push(o) }), []);
  const acme = outcomes.find(({ provider }) => provider === "acme");
  assert.deepEqual({ outcome: acme?.outcome, code: acme?.code }, { outcome: "failed", code: "malformed_fact" });
});
