import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfiguredMemoryService } from "../src/memory/provider-factory.ts";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import type { McpFetch } from "../src/mcp/mcp-client.ts";

const defaultMemory: MemoryService = {
  async recall() {
    return "personal notebook";
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
  async replace() {},
};

function response(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("configured provider runs OAuth MCP recall and explicit capture end to end", async () => {
  const calls: Array<{ url: string; body: string; authorization?: string }> = [];
  const fetchImpl: McpFetch = async (url, init) => {
    calls.push({ url, body: init.body, authorization: init.headers.authorization });
    if (url.endsWith("/token")) {
      const params = new URLSearchParams(init.body);
      return response({ access_token: `${params.get("client_id")}-token`, expires_in: 300 });
    }
    const rpc = JSON.parse(init.body) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
    return response({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: rpc.params.name === "search_knowledge" ? "org knowledge" : "ok" }] },
    });
  };
  const raw = JSON.stringify({
    providers: [
      {
        id: "knowledge",
        type: "mcp",
        url: "http://knowledge.internal:8080",
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
    fetchImpl,
  });

  assert.equal(await memory.recall("personal:u1", { query: "launch", actorId: "u1" }), "personal notebook");
  assert.equal(await memory.recall("org:acme", { query: "launch", actorId: "u1" }), "org knowledge");
  assert.equal(await memory.capture("org:acme", ["decision"], 1, "u1", { mode: "automatic" }), 0);
  assert.equal(await memory.capture("org:acme", ["decision"], 1, "u1", { mode: "explicit" }), 1);

  assert.equal(calls[0]?.url, "http://knowledge.internal:8080/token");
  assert.equal(calls[1]?.authorization, "Bearer ro-token");
  assert.match(calls[1]?.body ?? "", /search_knowledge/);
  assert.equal(calls[2]?.url, "http://knowledge.internal:8080/token");
  assert.equal(calls[3]?.authorization, "Bearer rw-token");
  assert.match(calls[3]?.body ?? "", /write_knowledge/);
});
