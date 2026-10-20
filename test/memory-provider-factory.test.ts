import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfiguredMemoryService } from "../src/memory/provider-factory.ts";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { startMcpTestServer } from "./support/mcp-test-server.ts";
import { recallText } from "./support/recall-text.ts";

const defaultMemory: MemoryService = {
  async recall() {
    return [{ text: "personal notebook", score: 0.2 }];
  },
  async capture(_scope, facts) {
    return facts.length;
  },
  async query() {
    return [];
  },
  async read() {
    return "personal notebook";
  },
};

test("configured provider runs OAuth MCP recall and explicit capture end to end", async (t) => {
  const mcp = await startMcpTestServer(t, {
    tools: ["search_knowledge", "write_knowledge"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
    clients: { ro: "x", rw: "y" },
    call: (name) => ({ content: [{ type: "text", text: name === "search_knowledge" ? "org knowledge" : "ok" }] }),
  });
  const raw = JSON.stringify({
    providers: [
      {
        id: "knowledge",
        type: "mcp",
        url: mcp.url,
        read: { tool: "search_knowledge", clientIdEnv: "RO_ID", clientSecretEnv: "RO_SECRET" },
        write: { tool: "write_knowledge", clientIdEnv: "RW_ID", clientSecretEnv: "RW_SECRET" },
      },
    ],
    routes: [
      { provider: "default", scopes: ["personal"], capture: "automatic" },
      { provider: "knowledge", scopes: ["org"], capture: "explicit", manage: false },
    ],
  });
  const memory = createConfiguredMemoryService({
    defaultMemory,
    config: parseMemoryProviderConfig(raw, { RO_ID: "ro", RO_SECRET: "x", RW_ID: "rw", RW_SECRET: "y" }),
  });

  assert.equal(recallText(await memory.recall("personal:u1", { query: "launch", actorId: "u1" })), "personal notebook");
  assert.equal(recallText(await memory.recall("org:acme", { query: "launch", actorId: "u1" })), "org knowledge");
  assert.equal(await memory.capture("org:acme", ["decision"], 1, "u1", { mode: "automatic" }), 0);
  assert.equal(await memory.capture("org:acme", ["decision"], 1, "u1", { mode: "explicit" }), 1);

  assert.deepEqual(
    mcp.tokenRequests.map((r) => r.clientId),
    ["ro", "rw"],
  );
  assert.deepEqual(
    mcp.requests.filter((r) => r.rpc === "tools/call").map((r) => r.authorization),
    ["Bearer ro-token-1", "Bearer rw-token-2"],
  );
});
