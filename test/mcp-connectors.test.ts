import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, mcpResultText, type McpFetch } from "../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService, mcpToolsForTurn, type McpCallContext } from "../src/mcp/mcp-tool-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";

function jsonResponse(body: unknown, status = 200, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
  };
}

const TOOLS = [
  { name: "query", description: "Run a query", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "update", description: "Write a record", inputSchema: { type: "object", properties: {} } },
];

function fakeServerFetch(opts?: { requireBearer?: string; sse?: boolean }): { fetch: McpFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push(url);
    if (opts?.requireBearer && init.headers.authorization !== `Bearer ${opts.requireBearer}`) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const req = JSON.parse(init.body) as { id: number; method: string; params: { name?: string } };
    const result =
      req.method === "tools/list" ? { tools: TOOLS } : { content: [{ type: "text", text: `ran ${req.params.name}` }] };
    const envelope = { jsonrpc: "2.0", id: req.id, result };
    if (opts?.sse) {
      return jsonResponse(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, 200, "text/event-stream");
    }
    return jsonResponse(envelope);
  };
  return { fetch, calls };
}

function server(partial?: Partial<McpServer>): McpServer {
  return {
    id: "crm",
    name: "CRM",
    url: "https://mcp.example.com/mcp",
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
    ...partial,
  };
}

test("mcp client lists tools and calls one over plain JSON", async () => {
  const { fetch } = fakeServerFetch();
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["query", "update"],
  );
  const result = await client.callTool("query", { q: "hi" });
  assert.equal(mcpResultText(result), "ran query");
});

test("mcp client parses SSE-framed responses", async () => {
  const { fetch } = fakeServerFetch({ sse: true });
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
});

test("mcp client sends bearer auth", async () => {
  const { fetch } = fakeServerFetch({ requireBearer: "sekret" });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "bearer", token: "sekret" },
    fetchImpl: fetch,
  });
  assert.equal((await client.listTools()).length, 2);
  const bad = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await assert.rejects(() => bad.listTools(), /HTTP 401/);
});

test("server id validation", () => {
  assert.ok(isValidMcpServerId("salesforce"));
  assert.ok(isValidMcpServerId("crm-2"));
  assert.ok(!isValidMcpServerId("Nope"));
  assert.ok(!isValidMcpServerId("x"));
  assert.ok(!isValidMcpServerId("has space"));
});

test("tool service exposes namespaced tools and calls through", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const defs = await service.toolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ["crm_query", "crm_update"]);
  assert.ok(defs.every((d) => d.readOnly));
  const out = await service.call("crm_query", { q: "hello" }, "internal:U1");
  assert.equal(out, "ran query");
  service.close();
});

test("tool discovery is limited by immutable principal and scope context", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const contexts: McpCallContext[] = [];
  const service = createMcpToolService({
    servers: store,
    fetchImpl: fakeServerFetch().fetch,
    refreshIntervalMs: 3600_000,
    authorize: async (context, target) => {
      contexts.push(context);
      return { allowed: context.scopeId === "project:west" && target.toolName === "query" };
    },
  });
  await store.put(server());
  await service.refresh();
  const west = await service.toolDefs({ principalId: "person-1", scopeId: "project:west", runId: "run-1" });
  const east = await service.toolDefs({ principalId: "person-1", scopeId: "project:east", runId: "run-1" });
  assert.deepEqual(
    west.map((tool) => tool.name),
    ["crm_query"],
  );
  assert.deepEqual(east, []);
  assert.deepEqual(contexts, [
    { principalId: "person-1", scopeId: "project:west", runId: "run-1" },
    { principalId: "person-1", scopeId: "project:west", runId: "run-1" },
    { principalId: "person-1", scopeId: "project:east", runId: "run-1" },
    { principalId: "person-1", scopeId: "project:east", runId: "run-1" },
  ]);
  service.close();
});

test("tool invocation is denied when the policy denies its immutable scope context", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({
    servers: store,
    fetchImpl: fakeServerFetch().fetch,
    refreshIntervalMs: 3600_000,
    authorize: async (context) => ({ allowed: context.scopeId === "project:west" }),
  });
  await store.put(server());
  await service.refresh();
  await assert.rejects(
    () => service.call("crm_query", {}, { principalId: "person-1", scopeId: "project:east", runId: "run-1" }),
    /not authorized/,
  );
  service.close();
});

test("dynamic authorization cannot replace configured static MCP authentication", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({
    servers: store,
    fetchImpl: fakeServerFetch().fetch,
    refreshIntervalMs: 3600_000,
    authorize: async () => ({ allowed: true, authorization: "Bearer dynamic" }),
  });
  await store.put(server({ auth: "bearer", bearerToken: "static-token" }));
  await service.refresh();
  await assert.rejects(
    () => service.call("crm_query", {}, { principalId: "person-1", scopeId: "project:west", runId: "run-1" }),
    /cannot add authorization to a statically authenticated MCP server/,
  );
  service.close();
});

test("an explicit empty per-turn MCP tool list masks legacy global tools", () => {
  const global = () => [{ name: "global_tool" } as never];
  assert.deepEqual(mcpToolsForTurn([], global)?.(), []);
  assert.deepEqual(mcpToolsForTurn(undefined, global)?.(), global());
});

test("malformed MCP contexts fail closed before the authorizer is invoked", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  let authorizations = 0;
  const service = createMcpToolService({
    servers: store,
    fetchImpl: fakeServerFetch().fetch,
    refreshIntervalMs: 3600_000,
    authorize: async () => {
      authorizations += 1;
      return { allowed: true };
    },
  });
  await store.put(server());
  await service.refresh();
  const malformed = { principalId: "person-1" } as unknown as McpCallContext;
  assert.deepEqual(await service.toolDefs(malformed), []);
  await assert.rejects(() => service.call("crm_query", {}, malformed), /not authorized/);
  assert.equal(authorizations, 0);
  service.close();
});

test("MCP authorization failures do not disclose policy error text", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const audit = createAuditLog();
  const service = createMcpToolService({
    servers: store,
    audit,
    fetchImpl: fakeServerFetch().fetch,
    refreshIntervalMs: 3600_000,
    authorize: async () => {
      throw new Error("ephemeral-authorization-secret");
    },
  });
  await store.put(server());
  await service.refresh();
  await assert.rejects(
    () => service.call("crm_query", {}, { principalId: "person-1", scopeId: "project:west" }),
    /MCP authorization failed/,
  );
  assert.ok((await audit.events()).every((event) => !JSON.stringify(event).includes("ephemeral-authorization-secret")));
  service.close();
});

test("disabled server's tools disappear and calls fail", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  assert.equal((await service.toolDefs()).length, 2);
  await store.put(server({ enabled: false }));
  await service.refresh();
  assert.equal((await service.toolDefs()).length, 0);
  service.close();
});

test("unknown tool call rejects", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool/);
  service.close();
});
