import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistryMemoryService } from "../src/memory/registry-memory.ts";
import { EMPTY_MEMORY_REGISTRY, putBinding, putBrain } from "../src/memory/registry.ts";
import { emptyMemoryRegistry } from "./support/memory-registry.ts";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";
import { loopbackFetch, startMcpTestServer } from "./support/mcp-test-server.ts";
import { recallText } from "./support/recall-text.ts";

const defaultMemory: MemoryService = {
  async recall() {
    return [{ text: "personal notebook" }];
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
  const memory = createRegistryMemoryService({
    registry: emptyMemoryRegistry,
    defaultMemory,
    overlay: parseMemoryProviderConfig(raw, { RO_ID: "ro", RO_SECRET: "x", RW_ID: "rw", RW_SECRET: "y" }),
  });

  assert.equal(recallText(await memory.recall("personal:u1", { query: "launch", actorId: "u1" })), "personal notebook");
  assert.equal(recallText(await memory.recall("org:acme", { query: "launch", actorId: "u1" })), "org knowledge");
  assert.equal(
    await memory.capture(
      "org:acme",
      ["decision"],
      1,
      { actorId: "u1", context: "conversation" },
      { mode: "automatic" },
    ),
    0,
  );
  assert.equal(
    await memory.capture("org:acme", ["decision"], 1, { actorId: "u1", context: "conversation" }, { mode: "explicit" }),
    1,
  );

  assert.deepEqual(mcp.tokenRequests, ["ro", "rw"]);
  assert.deepEqual(
    mcp.requests.filter((r) => r.rpc === "tools/call").map((r) => r.authorization),
    ["Bearer ro-token-1", "Bearer rw-token-2"],
  );
});

test("a registry brain is called only through the guarded fetch, which refuses private addresses", async (t) => {
  const brain = await startMcpTestServer(t, {
    tools: [{ name: "memory_recall", inputSchema: { type: "object" as const } }],
    clients: { "qm-personal": "personal-secret" },
    call: () => ({ content: [{ type: "text", text: "Alice keeps bees." }] }),
  });
  const change = {
    actor: "admin-alice",
    now: 1_762_128_000_000,
    overlayIds: new Set<string>(),
    key: emptyMemoryRegistry.key,
  };
  const registered = putBrain(
    EMPTY_MEMORY_REGISTRY,
    "acme-personal",
    {
      preset: "gbrain-v1",
      url: "https://brain.acme.example/mcp",
      clientId: "qm-personal",
      clientSecret: "personal-secret",
      label: "Acme personal memory",
    },
    change,
  );
  const storedEarlier = { ...registered, brains: registered.brains.map((entry) => ({ ...entry, url: brain.url })) };
  const record = putBinding(
    storedEarlier,
    "alice",
    { brain: "acme-personal", scope: "personal:U1", capture: "explicit" },
    change,
  );
  const errors: unknown[] = [];
  const serving = (registryFetch?: typeof loopbackFetch) =>
    createRegistryMemoryService({
      defaultMemory,
      registry: { ...emptyMemoryRegistry, current: async () => ({ version: "1", record }) },
      ...(registryFetch ? { registryFetch } : {}),
      onError: (error) => void errors.push(error),
    });

  const refused = await serving().recall("personal:U1", {
    query: "bees",
    actorId: "U1",
    audienceScopeId: "personal:U1",
  });
  assert.equal(recallText(refused), "personal notebook");
  assert.match(String((errors[0] as Error | undefined)?.cause ?? errors[0]), /private network address/);
  assert.deepEqual([brain.requests, brain.tokenRequests], [[], []]);

  const allowed = await serving(loopbackFetch).recall("personal:U1", {
    query: "bees",
    actorId: "U1",
    audienceScopeId: "personal:U1",
  });
  assert.match(recallText(allowed), /Alice keeps bees\./);
});
