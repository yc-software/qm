import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, mcpResultText, type McpFetch } from "../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService, sanitizeToolSchema } from "../src/mcp/mcp-tool-service.ts";
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

test("tool schemas ingest with internal refs inlined", async () => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const schema = {
    type: "object",
    $defs: { id: { type: "string", minLength: 1 } },
    properties: {
      board: { $ref: "#/$defs/id" },
      parent: { $ref: "#/properties/board" },
      missing: { $ref: "#/$defs/nope" },
      external: { $ref: "https://example.com/schema.json#/x" },
    },
  };
  const fetch: McpFetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: number; method: string };
    if (req.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: [{ name: "create", description: "Create", inputSchema: schema }] },
      });
    }
    return jsonResponse({ jsonrpc: "2.0", id: req.id, result: {} });
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const def = service.toolDefs().find((d) => d.name === "crm_create");
  assert.ok(def);
  const props = (def.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.equal(JSON.stringify(def.inputSchema).includes("$ref"), false);
  assert.deepEqual(props.board, { type: "string", minLength: 1 });
  assert.deepEqual(props.parent, { type: "string", minLength: 1 });
  assert.deepEqual(props.missing, {});
  assert.deepEqual(props.external, {});
  assert.equal((def.inputSchema as Record<string, unknown>).$defs, undefined);
  service.close();
});

test("sanitizeToolSchema keeps keywords that sit beside a $ref", () => {
  const out = sanitizeToolSchema({
    type: "object",
    $defs: { int: { type: "integer" } },
    properties: {
      count: { $ref: "#/$defs/int", minimum: 1, maximum: 10, description: "1..10 only" },
    },
  }) as { properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(out.properties.count, {
    type: "integer",
    minimum: 1,
    maximum: 10,
    description: "1..10 only",
  });
});

test("sanitizeToolSchema always yields an object schema", () => {
  const fallback = { type: "object", properties: {}, additionalProperties: true };
  assert.deepEqual(sanitizeToolSchema({ $ref: "#/$defs/Input" }), fallback);
  assert.deepEqual(sanitizeToolSchema({ $ref: "#" }), fallback);
  assert.deepEqual(sanitizeToolSchema({ type: "string" }), fallback);
  assert.deepEqual(sanitizeToolSchema({ properties: { a: { type: "string" } } }), {
    type: "object",
    properties: { a: { type: "string" } },
  });
});

test("sanitizeToolSchema bounds expansion instead of exploding", () => {
  const width = 8;
  const depth = 8;
  const defs: Record<string, unknown> = { leaf: { type: "string" } };
  for (let level = 1; level <= depth; level += 1) {
    const properties: Record<string, unknown> = {};
    const child = level === 1 ? "#/$defs/leaf" : `#/$defs/level${level - 1}`;
    for (let field = 0; field < width; field += 1) properties[`f${field}`] = { $ref: child };
    defs[`level${level}`] = { type: "object", properties };
  }
  const schema = { type: "object", $defs: defs, properties: { root: { $ref: `#/$defs/level${depth}` } } };
  const started = Date.now();
  const out = sanitizeToolSchema(schema);
  assert.ok(Date.now() - started < 2000);
  assert.ok(JSON.stringify(out).length < 2_000_000);
});

test("sanitizeToolSchema survives deep nesting without refs", () => {
  let node: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 5000; i += 1) node = { type: "object", properties: { next: node } };
  assert.equal(typeof sanitizeToolSchema(node), "object");
});

test("sanitizeToolSchema resolves escaped and indexed pointers", () => {
  const out = sanitizeToolSchema({
    type: "object",
    $defs: { "a/b": { type: "number" }, "c~d": { type: "boolean" }, "e f": { type: "null" } },
    prefixItems: [{ type: "integer" }],
    properties: {
      slash: { $ref: "#/$defs/a~1b" },
      tilde: { $ref: "#/$defs/c~0d" },
      spaced: { $ref: "#/$defs/e%20f" },
      indexed: { $ref: "#/prefixItems/0" },
    },
  }) as { properties: Record<string, unknown> };
  assert.deepEqual(out.properties.slash, { type: "number" });
  assert.deepEqual(out.properties.tilde, { type: "boolean" });
  assert.deepEqual(out.properties.spaced, { type: "null" });
  assert.deepEqual(out.properties.indexed, { type: "integer" });
});

test("sanitizeToolSchema stops cyclic refs, direct and mutual", () => {
  const direct = sanitizeToolSchema({
    type: "object",
    properties: { self: { $ref: "#/properties/self" } },
  }) as { properties: Record<string, unknown> };
  assert.deepEqual(direct.properties.self, {});
  const mutual = sanitizeToolSchema({
    type: "object",
    $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } },
    properties: { start: { $ref: "#/$defs/a" } },
  }) as { properties: Record<string, unknown> };
  assert.deepEqual(mutual.properties.start, {});
});

test("sanitizeToolSchema drops nested $defs and a __proto__ key", () => {
  const out = sanitizeToolSchema({
    type: "object",
    properties: {
      nested: { type: "object", $defs: { x: { type: "string" } }, definitions: { y: { type: "string" } } },
    },
  }) as { properties: Record<string, Record<string, unknown> | undefined> };
  assert.equal(out.properties.nested?.$defs, undefined);
  assert.equal(out.properties.nested?.definitions, undefined);
  assert.deepEqual(out.properties.nested, { type: "object" });

  const hostile = sanitizeToolSchema(
    JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"string"}}}'),
  ) as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(hostile.properties), ["ok"]);
  assert.equal(Object.getPrototypeOf(hostile.properties), Object.prototype);
});

test("sanitizeToolSchema keeps a false subschema restrictive", () => {
  const out = sanitizeToolSchema({
    type: "object",
    $defs: { never: false },
    properties: { blocked: { $ref: "#/$defs/never" } },
  }) as { properties: Record<string, unknown> };
  assert.deepEqual(out.properties.blocked, { not: {} });
});
