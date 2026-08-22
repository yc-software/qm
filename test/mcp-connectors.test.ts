import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, mcpResultText, type McpFetch } from "../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

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
  const defs = service.toolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ["crm_query", "crm_update"]);
  assert.ok(defs.every((d) => d.readOnly));
  const out = await service.call("crm_query", { q: "hello" }, "internal:U1");
  assert.equal(out, "ran query");
  service.close();
});

test("disabled server's tools disappear and calls fail", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  assert.equal(service.toolDefs().length, 2);
  await store.put(server({ enabled: false }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 0);
  service.close();
});

test("unknown tool call rejects", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool/);
  service.close();
});

function sessionResponse(body: unknown, sessionId: string) {
  const base = jsonResponse(body);
  return {
    ...base,
    headers: {
      get: (n: string) => {
        const name = n.toLowerCase();
        if (name === "mcp-session-id") return sessionId;
        return name === "content-type" ? "application/json" : null;
      },
    },
  };
}

test("mcp client negotiates a session and echoes the id on later calls", async () => {
  const sessions: Array<string | undefined> = [];
  const methods: string[] = [];
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id?: number; method: string };
    methods.push(req.method);
    sessions.push(init.headers["mcp-session-id"]);
    if (req.method === "initialize") return sessionResponse({ jsonrpc: "2.0", id: req.id, result: {} }, "sess-1");
    if (!init.headers["mcp-session-id"]) return jsonResponse({ error: "No valid session ID provided" }, 400);
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  assert.deepEqual((await client.listTools()).map((t) => t.name), ["query", "update"]);
  assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
  assert.deepEqual(sessions, [undefined, "sess-1", "sess-1"]);
});

test("mcp client keeps sessionless servers on the pre-session request shape", async () => {
  const sessions: Array<string | undefined> = [];
  const { fetch } = fakeServerFetch();
  const wrapped: McpFetch = async (url, init) => {
    sessions.push(init.headers["mcp-session-id"]);
    return fetch(url, init);
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: wrapped });
  assert.deepEqual((await client.listTools()).map((t) => t.name), ["query", "update"]);
  assert.deepEqual((await client.listTools()).map((t) => t.name), ["query", "update"]);
  assert.ok(sessions.every((s) => s === undefined));
});

test("mcp client survives a server that does not implement initialize", async () => {
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id?: number; method: string };
    if (req.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } });
    }
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  assert.deepEqual((await client.listTools()).map((t) => t.name), ["query", "update"]);
});

test("mcp client surfaces an unauthorized initialize instead of falling back", async () => {
  const fetch: McpFetch = async () => jsonResponse({ error: "unauthorized" }, 401);
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await assert.rejects(() => client.listTools(), /initialize failed \(HTTP 401\)/);
});

test("concurrent first calls negotiate one shared session", async () => {
  let issued = 0;
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id?: number; method: string };
    if (req.method === "initialize") {
      issued += 1;
      return sessionResponse({ jsonrpc: "2.0", id: req.id, result: {} }, `sess-${issued}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const results = await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
  assert.equal(issued, 1);
  assert.ok(results.every((tools) => tools.length === 2));
});

test("every caller recovers when the server drops the shared session", async () => {
  let issued = 0;
  const dead = new Set<string>();
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id?: number; method: string };
    if (req.method === "initialize") {
      issued += 1;
      return sessionResponse({ jsonrpc: "2.0", id: req.id, result: {} }, `sess-${issued}`);
    }
    const active = init.headers["mcp-session-id"];
    if (req.method === "tools/list" && active && dead.has(active)) return jsonResponse({ error: "gone" }, 404);
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await client.listTools();
  dead.add("sess-1");
  const results = await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
  assert.ok(results.every((tools) => tools.length === 2));
  assert.equal(issued, 2);
});

test("a genuine bad request is not retried on a live session", async () => {
  const calls: string[] = [];
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id?: number; method: string };
    calls.push(req.method);
    if (req.method === "initialize") return sessionResponse({ jsonrpc: "2.0", id: req.id, result: {} }, "sess-1");
    if (req.method === "tools/call") return jsonResponse({ error: "bad request" }, 400);
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
  };
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await assert.rejects(() => client.callTool("update", {}), /tools\/call failed \(HTTP 400\)/);
  assert.equal(calls.filter((m) => m === "tools/call").length, 1);
  assert.equal(calls.filter((m) => m === "initialize").length, 1);
});
