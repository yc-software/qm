import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, mcpResultText, type McpFetch } from "../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
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

function tokenStore() {
  return createKeychain({
    creds: createMemoryMap<KeychainCredential>(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("mcp-test-encryption-key"),
  });
}

test("per-user calls resolve only the caller's fresh token while discovery uses catalog auth", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "alice-token" });
  await users.setConnectorToken(host, "internal:bob", { accessToken: "bob-token" });
  const catalogAuth: string[] = [];
  const callAuth: string[] = [];
  const service = createMcpToolService({
    servers: store,
    userTokens: users,
    fetchImpl: async (_url, init) => {
      const rpc = JSON.parse(init.body);
      if (rpc.method === "tools/list") {
        catalogAuth.push(init.headers.authorization!);
        return jsonResponse({ result: { tools: TOOLS } });
      }
      callAuth.push(init.headers.authorization!);
      return jsonResponse({ result: { content: [{ type: "text", text: rpc.params.arguments.q }] } });
    },
  });
  t.after(() => service.close());
  await store.put(
    server({ auth: "bearer", bearerToken: "catalog-only", credentialScope: "per-user", credentialHost: host }),
  );
  await service.refresh();
  assert.deepEqual(await service.probe((await store.get("crm"))!), ["query", "update"]);
  assert.ok(catalogAuth.length > 0);
  assert.ok(catalogAuth.every((auth) => auth === "Bearer catalog-only"));
  assert.deepEqual(
    await Promise.all([
      service.call("crm_query", { q: "alice" }, "internal:alice"),
      service.call("crm_query", { q: "bob" }, "internal:bob"),
    ]),
    ["alice", "bob"],
  );
  assert.deepEqual(callAuth.sort(), ["Bearer alice-token", "Bearer bob-token"]);
  await users.setConnectorToken(host, "internal:alice", { accessToken: "rotated-alice" });
  await service.call("crm_query", { q: "rotated" }, "internal:alice");
  assert.equal(callAuth.at(-1), "Bearer rotated-alice");
  await users.deleteConnectorToken(host, "internal:alice");
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /Connect your account/);
  await assert.rejects(service.call("crm_query", {}), /requires a connected user/);
  await assert.rejects(
    service.call("crm_query", { principalId: "internal:bob" }, "internal:mallory"),
    /Connect your account/,
  );
  await users.setConnectorToken(host, "internal:bob", { accessToken: "expired", expiresAt: 1 });
  await assert.rejects(service.call("crm_query", {}, "internal:bob"), /Connect your account/);
  assert.equal(callAuth.length, 3);
});

test("per-user mode fails closed without a keychain and shared mode preserves existing behavior", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const { fetch, calls } = fakeServerFetch({ requireBearer: "shared-token" });
  const service = createMcpToolService({ servers: store, fetchImpl: fetch });
  t.after(() => service.close());
  await store.put(
    server({
      auth: "bearer",
      bearerToken: "shared-token",
      credentialScope: "per-user",
      credentialHost: "accounts.example.com",
    }),
  );
  await service.refresh();
  const count = calls.length;
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /requires a connected user/);
  assert.equal(calls.length, count);
  await store.put(server({ auth: "bearer", bearerToken: "shared-token", credentialScope: "shared" }));
  await service.refresh();
  assert.equal(await service.call("crm_query", {}), "ran query");
});

test("MCP HTTP transport refuses redirects before sending a user token to another endpoint", async (t) => {
  let targetRequests = 0;
  const target = createServer((_req, res) => {
    targetRequests++;
    res.end("{}");
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const redirected = createServer((_req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/mcp` });
    res.end();
  });
  redirected.listen(0, "127.0.0.1");
  await once(redirected, "listening");
  t.after(() => {
    target.close();
    redirected.close();
  });
  const client = createMcpClient({
    url: `http://127.0.0.1:${(redirected.address() as AddressInfo).port}`,
    auth: { mode: "bearer", token: "private-user-token" },
  });
  await assert.rejects(client.callTool("query", {}));
  assert.equal(targetRequests, 0);
});

test("per-user connectors select an explicit account slot without falling back to another slot", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "default-token" });
  await users.setConnectorToken(host, "internal:alice", { accessToken: "company-token" }, "company");
  const { fetch } = fakeServerFetch({ requireBearer: "company-token" });
  const service = createMcpToolService({ servers: store, userTokens: users, fetchImpl: fetch });
  t.after(() => service.close());
  await store.put(
    server({
      auth: "bearer",
      bearerToken: "company-token",
      credentialScope: "per-user",
      credentialHost: host,
      credentialAccountType: "company",
    }),
  );
  await service.refresh();
  assert.equal(await service.call("crm_query", {}, "internal:alice"), "ran query");
  await users.deleteConnectorToken(host, "internal:alice", "company");
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /Connect your account/);
});

test("tool schemas inline local refs without rewriting values or no-ref schemas", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const literal = { $ref: "literal", $defs: { untouched: true } };
  const native = {
    type: "object",
    patternProperties: { "^x": { type: "string" } },
    unevaluatedProperties: false,
  };
  const tools = [
    {
      name: "normalized",
      inputSchema: {
        type: "object",
        $defs: {
          count: { type: "integer", minimum: 5 },
          "a/b": { type: "string", minLength: 1 },
          "space name": { type: "boolean" },
        },
        properties: {
          count: { $ref: "#/$defs/count", maximum: 10, description: "bounded" },
          alias: { $ref: "#/properties/count" },
          slash: { $ref: "#/$defs/a~1b" },
          space: { $ref: "#/$defs/space%20name" },
          literal: { type: "object", const: literal },
          $ref: { type: "string" },
        },
        required: ["count"],
      },
    },
    { name: "native", inputSchema: native },
  ];
  const service = createMcpToolService({
    servers: store,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id: number };
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools } });
    },
  });
  t.after(() => service.close());
  await store.put(server());
  await service.refresh();
  const normalized = service.toolDefs().find((tool) => tool.remoteName === "normalized")!.inputSchema;
  const properties = normalized.properties as Record<string, unknown>;
  const count = { type: "integer", minimum: 5, maximum: 10, description: "bounded" };
  assert.deepEqual(properties, {
    count,
    alias: count,
    slash: { type: "string", minLength: 1 },
    space: { type: "boolean" },
    literal: { type: "object", const: literal },
    $ref: { type: "string" },
  });
  assert.equal(Object.hasOwn(normalized, "$defs"), false);
  assert.deepEqual(service.toolDefs().find((tool) => tool.remoteName === "native")!.inputSchema, native);
});

test("tool schema failures omit only the unsafe tool and bound ref expansion", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const defs: Record<string, unknown> = { leaf: { type: "string" } };
  for (let level = 1; level <= 7; level += 1) {
    const child = level === 1 ? "#/$defs/leaf" : `#/$defs/level${level - 1}`;
    defs[`level${level}`] = {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 6 }, (_, field) => [`f${field}`, { $ref: child }])),
    };
  }
  const description = "x".repeat(10_000);
  const wide = {
    type: "object",
    $defs: { value: { type: "string", description } },
    properties: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`f${index}`, { $ref: "#/$defs/value" }])),
  };
  const nestedResourceRef = {
    type: "object",
    $defs: { value: { type: "string" } },
    properties: {
      nested: {
        $id: "nested",
        type: "object",
        $defs: { value: { type: "integer" } },
        properties: { value: { $ref: "#/$defs/value" } },
      },
    },
  };
  const schemas = [
    { type: "object", properties: { value: { $ref: "#/$defs/missing" } } },
    { type: "object", properties: { value: { $ref: "https://example.com/schema.json" } } },
    { type: "object", properties: { value: { $ref: "#/properties/value" } } },
    {
      type: "object",
      $defs: { value: { type: "integer", minimum: 5 } },
      properties: { value: { $ref: "#/$defs/value", minimum: 1 } },
    },
    {
      type: "object",
      $defs: { closed: { type: "object", additionalProperties: false } },
      properties: {
        value: { $ref: "#/$defs/closed", properties: { allowed: { type: "string" } } },
      },
    },
    {
      type: "object",
      $defs: { anchored: { $anchor: "value", type: "string" } },
      properties: { one: { $ref: "#/$defs/anchored" }, two: { $ref: "#/$defs/anchored" } },
    },
    {
      type: "object",
      properties: { dynamic: { $dynamicRef: "#value" } },
    },
    {
      type: "object",
      properties: { recursive: { $recursiveRef: "#" } },
    },
    { type: "object", $defs: defs, properties: { value: { $ref: "#/$defs/level7" } } },
    wide,
    nestedResourceRef,
    { type: "string" },
  ];
  const service = createMcpToolService({
    servers: store,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id: number };
      const tools = [
        ...schemas.map((inputSchema, index) => ({ name: `unsafe${index}`, inputSchema })),
        { name: "good", inputSchema: { type: "object", properties: { ok: { type: "boolean" } } } },
      ];
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools } });
    },
  });
  t.after(() => service.close());
  await store.put(server());
  await service.refresh();
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.remoteName),
    ["good"],
  );
});

test("tool schema refresh budget skips overflow without consuming later capacity", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const description = "x".repeat(680_000);
  const tools = [
    ...Array.from({ length: 3 }, (_, index) => ({
      name: `large${index}`,
      inputSchema: { type: "object", description, properties: {} },
    })),
    { name: "small", inputSchema: { type: "object", properties: {} } },
  ];
  const service = createMcpToolService({
    servers: store,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id: number };
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools } });
    },
  });
  t.after(() => service.close());
  await store.put(server());
  await service.refresh();
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.remoteName),
    ["large0", "large1", "small"],
  );
});
