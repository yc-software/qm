import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createMcpClient, mcpResultText } from "../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { startMcpFixture } from "./support/mcp-fixture.ts";

function server(url: string, partial?: Partial<McpServer>): McpServer {
  return {
    id: "crm",
    name: "CRM",
    url,
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
    ...partial,
  };
}

test("mcp client initializes a session, reuses it, and calls tools", async (t) => {
  const fixture = await startMcpFixture();
  const client = createMcpClient({ url: fixture.url, auth: { mode: "none" } });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    ["query", "update"],
  );
  assert.equal(mcpResultText(await client.callTool("query", { q: "hi" })), "ran query hi");
  const posts = fixture.requests.filter((r) => r.method !== "GET");
  assert.deepEqual(
    posts.map((r) => r.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/call"],
  );
  assert.equal(posts[0]!.sessionId, undefined);
  assert.ok(posts.slice(1).every((r) => r.sessionId && r.sessionId === posts[1]!.sessionId));
});

test("mcp client follows tools/list cursors and honors the tool limit", async (t) => {
  const tools = ["a", "b", "c", "d", "e"].map((name) => ({ name }));
  const fixture = await startMcpFixture({ tools, pageSize: 2 });
  const client = createMcpClient({ url: fixture.url, auth: { mode: "none" } });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(
    (await client.listTools(3)).map((tool) => tool.name),
    ["a", "b", "c"],
  );
});

test("mcp client uses the configured endpoint verbatim", async (t) => {
  const fixture = await startMcpFixture({ path: "/v2/rpc" });
  const client = createMcpClient({ url: fixture.url, auth: { mode: "none" } });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  assert.equal((await client.listTools()).length, 2);
});

test("mcp client sends bearer auth and surfaces rejection", async (t) => {
  const fixture = await startMcpFixture({ bearer: "sekret" });
  const client = createMcpClient({ url: fixture.url, auth: { mode: "bearer", token: "sekret" } });
  const bad = createMcpClient({ url: fixture.url, auth: { mode: "none" } });
  t.after(async () => {
    await client.close();
    await bad.close();
    await fixture.close();
  });
  assert.equal((await client.listTools()).length, 2);
  assert.ok(fixture.requests.every((r) => r.authorization === "Bearer sekret"));
  await assert.rejects(
    () => bad.listTools(),
    (error: { code?: unknown }) => error.code === 401,
  );
});

test("client-credentials auth mints a token and re-mints after the server revokes it", async (t) => {
  const credentials = { clientId: "svc", clientSecret: "shh" };
  const fixture = await startMcpFixture({ clientCredentials: [credentials] });
  const client = createMcpClient({ url: fixture.url, auth: { mode: "client-credentials", ...credentials } });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  assert.equal(fixture.mints, 1);
  while (!fixture.requests.some((request) => request.method === "GET")) await new Promise((r) => setTimeout(r, 5));
  fixture.revokeTokens();
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  assert.equal(fixture.mints, 2);
  assert.deepEqual(
    fixture.calls.map((call) => call.authorization),
    ["Bearer svc-1", "Bearer svc-2"],
  );
});

test("mcp client re-initializes once when the server forgets its session", async (t) => {
  const fixture = await startMcpFixture();
  const client = createMcpClient({ url: fixture.url, auth: { mode: "none" } });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  await client.callTool("query", {});
  fixture.dropSessions();
  assert.equal(mcpResultText(await client.callTool("update", {})), "ran update");
  assert.equal(fixture.requests.filter((r) => r.method === "initialize").length, 2);
  assert.deepEqual(
    fixture.calls.map((call) => call.name),
    ["query", "update"],
  );
});

test("aborting a call cancels it on the server", async (t) => {
  const fixture = await startMcpFixture();
  const client = createMcpClient({ url: fixture.url, auth: { mode: "none" } });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  const controller = new AbortController();
  const pending = client.callTool("slow", {}, { signal: controller.signal });
  while (!fixture.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending);
  while (!fixture.cancelled.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(fixture.cancelled, ["slow"]);
});

test("a call that outlives its deadline is rejected and cancelled", async (t) => {
  const fixture = await startMcpFixture();
  const client = createMcpClient({ url: fixture.url, auth: { mode: "none" } });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  await assert.rejects(client.callTool("slow", {}, { timeoutMs: 50 }), /time(d )?out/i);
  while (!fixture.cancelled.length) await new Promise((resolve) => setTimeout(resolve, 5));
});

test("a call's deadline covers connecting, and an expired call leaves the shared connection to finish for others", async (t) => {
  const fixture = await startMcpFixture({ initializeDelayMs: 1_500 });
  const client = createMcpClient({ url: fixture.url, auth: { mode: "none" } });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  const patient = client.callTool("query", { q: "later" });
  const started = Date.now();
  await assert.rejects(client.callTool("query", { q: "now" }, { timeoutMs: 100 }), { name: "TimeoutError" });
  assert.ok(Date.now() - started < 1_000, "the budget is not spent waiting for initialize");
  assert.equal(mcpResultText(await patient), "ran query later");
  assert.equal(fixture.requests.filter((r) => r.method === "initialize").length, 1);
});

test("tool results keep non-text content visible", async (t) => {
  const fixture = await startMcpFixture({
    reply: () => ({
      content: [
        { type: "text", text: "summary" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///notes.txt", text: "notes body" } },
      ],
    }),
  });
  const client = createMcpClient({ url: fixture.url, auth: { mode: "none" } });
  t.after(async () => {
    await client.close();
    await fixture.close();
  });
  assert.equal(mcpResultText(await client.callTool("query", {})), "summary\n[image image/png]\nnotes body");
});

test("server id validation", () => {
  assert.ok(isValidMcpServerId("salesforce"));
  assert.ok(isValidMcpServerId("crm-2"));
  assert.ok(!isValidMcpServerId("Nope"));
  assert.ok(!isValidMcpServerId("x"));
  assert.ok(!isValidMcpServerId("has space"));
});

test("tool service exposes provider-safe namespaced tools and calls through", async (t) => {
  const long = "x".repeat(80);
  const fixture = await startMcpFixture({
    tools: [
      { name: "query", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "union", inputSchema: { type: "object", anyOf: [{ required: ["a"] }], properties: { a: {} } } },
      { name: `${long}1` },
      { name: `${long}2` },
    ],
  });
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const audits: string[] = [];
  const service = createMcpToolService({
    servers: store,
    refreshIntervalMs: 3600_000,
    audit: { record: (event: { status: string }) => void audits.push(event.status) } as never,
  });
  t.after(async () => {
    service.close();
    await fixture.close();
  });
  await store.put(server(fixture.url));
  await service.refresh();
  const defs = service.toolDefs();
  assert.deepEqual(
    defs.map((d) => d.name),
    ["crm_query", "crm_union", `crm_${long}`.slice(0, 64)],
  );
  assert.ok(defs.every((d) => d.name.length <= 64 && d.readOnly));
  assert.deepEqual(defs[1]!.inputSchema, { type: "object", properties: { a: {} } });
  assert.ok(audits.some((status) => status.includes(`dropped=${long}2`)));
  assert.equal(await service.call("crm_query", { q: "hello" }, "internal:U1"), "ran query hello");
});

test("disabled server's tools disappear and calls fail", async (t) => {
  const fixture = await startMcpFixture();
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  t.after(async () => {
    service.close();
    await fixture.close();
  });
  await store.put(server(fixture.url));
  await service.refresh();
  assert.equal(service.toolDefs().length, 2);
  await store.put(server(fixture.url, { enabled: false }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 0);
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

test("per-user calls use only the caller's fresh token while discovery uses catalog auth", async (t) => {
  const fixture = await startMcpFixture({ reply: (_name, args) => ({ content: [{ type: "text", text: args.q }] }) });
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "alice-token" });
  await users.setConnectorToken(host, "internal:bob", { accessToken: "bob-token" });
  const service = createMcpToolService({ servers: store, userTokens: users });
  t.after(async () => {
    service.close();
    await fixture.close();
  });
  await store.put(
    server(fixture.url, {
      auth: "bearer",
      bearerToken: "catalog-only",
      credentialScope: "per-user",
      credentialHost: host,
    }),
  );
  await service.refresh();
  assert.deepEqual(await service.probe((await store.get("crm"))!), ["query", "update"]);
  assert.ok(
    fixture.requests.filter((r) => r.method === "tools/list").every((r) => r.authorization === "Bearer catalog-only"),
  );
  assert.deepEqual(
    await Promise.all([
      service.call("crm_query", { q: "alice" }, "internal:alice"),
      service.call("crm_query", { q: "bob" }, "internal:bob"),
    ]),
    ["alice", "bob"],
  );
  await service.call("crm_query", { q: "again" }, "internal:alice");
  assert.deepEqual(fixture.calls.map((call) => call.authorization).sort(), [
    "Bearer alice-token",
    "Bearer alice-token",
    "Bearer bob-token",
  ]);
  const handshakes = fixture.requests.filter((r) => r.method === "initialize").length;
  await users.setConnectorToken(host, "internal:alice", { accessToken: "rotated-alice" });
  await service.call("crm_query", { q: "rotated" }, "internal:alice");
  assert.equal(fixture.calls.at(-1)?.authorization, "Bearer rotated-alice");
  assert.equal(fixture.requests.filter((r) => r.method === "initialize").length, handshakes + 1);
  await users.deleteConnectorToken(host, "internal:alice");
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /Connect your account/);
  await assert.rejects(service.call("crm_query", {}), /requires a connected user/);
  await assert.rejects(
    service.call("crm_query", { principalId: "internal:bob" }, "internal:mallory"),
    /Connect your account/,
  );
  await users.setConnectorToken(host, "internal:bob", { accessToken: "expired", expiresAt: 1 });
  await assert.rejects(service.call("crm_query", {}, "internal:bob"), /Connect your account/);
  assert.equal(fixture.calls.length, 4);
});

test("per-user mode fails closed without a keychain and shared mode keeps working", async (t) => {
  const fixture = await startMcpFixture({ bearer: "shared-token" });
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store });
  t.after(async () => {
    service.close();
    await fixture.close();
  });
  const shared = { auth: "bearer" as const, bearerToken: "shared-token" };
  await store.put(
    server(fixture.url, { ...shared, credentialScope: "per-user", credentialHost: "accounts.example.com" }),
  );
  await service.refresh();
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /requires a connected user/);
  assert.equal(fixture.calls.length, 0);
  await store.put(server(fixture.url, { ...shared, credentialScope: "shared" }));
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
  const client = createMcpClient({
    url: `http://127.0.0.1:${(redirected.address() as AddressInfo).port}/mcp`,
    auth: { mode: "bearer", token: "private-user-token" },
  });
  t.after(async () => {
    await client.close();
    target.close();
    redirected.close();
  });
  await assert.rejects(client.callTool("query", {}));
  assert.equal(targetRequests, 0);
});

test("per-user connectors select an explicit account slot without falling back to another slot", async (t) => {
  const fixture = await startMcpFixture({ bearer: "company-token" });
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "default-token" });
  await users.setConnectorToken(host, "internal:alice", { accessToken: "company-token" }, "company");
  const service = createMcpToolService({ servers: store, userTokens: users });
  t.after(async () => {
    service.close();
    await fixture.close();
  });
  await store.put(
    server(fixture.url, {
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

test("background MCP refresh contains registry failures at startup, on change, and on its timer", async (t) => {
  const fixture = await startMcpFixture();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const list = t.mock.method(store, "list", async () => {
    throw new Error("registry unavailable");
  });
  const errors = t.mock.method(console, "error", () => {});
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 100 });
  t.after(async () => {
    service.close();
    await fixture.close();
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
  assert.equal(list.mock.callCount(), 1);
  await store.put(server(fixture.url));
  await settle();
  assert.equal(list.mock.callCount(), 2);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(list.mock.callCount(), 3);
  assert.equal(errors.mock.callCount(), 3);
  await assert.rejects(service.refresh(), /registry unavailable/);
  list.mock.restore();
  await service.refresh();
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.name),
    ["crm_query", "crm_update"],
  );
  assert.equal(await service.call("crm_query", {}), "ran query");
});

test("a token rotation never closes a client under an in-flight call", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fixture = await startMcpFixture({
    reply: (_name, args) =>
      args.wait ? gate.then(() => ({ content: [{ type: "text", text: "slow done" }] })) : undefined,
  });
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "t1" });
  const service = createMcpToolService({ servers: store, userTokens: users });
  t.after(async () => {
    service.close();
    await fixture.close();
  });
  await store.put(server(fixture.url, { credentialScope: "per-user", credentialHost: host }));
  await service.refresh();
  const slow = service.call("crm_query", { wait: true }, "internal:alice");
  while (!fixture.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
  await users.setConnectorToken(host, "internal:alice", { accessToken: "t2" });
  assert.equal(await service.call("crm_query", { q: "fast" }, "internal:alice"), "ran query fast");
  release();
  assert.equal(await slow, "slow done");
});
