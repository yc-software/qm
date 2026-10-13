import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfiguredMemoryService } from "../src/memory/provider-factory.ts";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { startMcpFixture } from "./support/mcp-fixture.ts";

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

test("configured provider runs OAuth MCP recall and explicit capture end to end", async (t) => {
  const fixture = await startMcpFixture({
    clientCredentials: [
      { clientId: "ro", clientSecret: "x" },
      { clientId: "rw", clientSecret: "y" },
    ],
    reply: (name) => ({ content: [{ type: "text", text: name === "search_knowledge" ? "org knowledge" : "ok" }] }),
  });
  t.after(() => fixture.close());
  const raw = JSON.stringify({
    providers: [
      {
        id: "knowledge",
        type: "mcp",
        url: fixture.url,
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

  assert.equal(await memory.recall("personal:u1", { query: "launch", actorId: "u1" }), "personal notebook");
  assert.equal(await memory.recall("org:acme", { query: "launch", actorId: "u1" }), "org knowledge");
  assert.equal(await memory.capture("org:acme", ["decision"], 1, "u1", { mode: "automatic" }), 0);
  assert.equal(await memory.capture("org:acme", ["decision"], 1, "u1", { mode: "explicit" }), 1);

  assert.deepEqual(
    fixture.calls.map((call) => [call.name, call.authorization]),
    [
      ["search_knowledge", "Bearer ro-1"],
      ["write_knowledge", "Bearer rw-2"],
    ],
  );
});
