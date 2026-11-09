import { tenantTest as test } from "./support/tenant-test.ts";
import assert from "node:assert/strict";
import { createMcpClient, mcpResultText } from "../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { settle } from "./support/settle.ts";
import { loopbackFetch, startMcpTestServer } from "./support/mcp-test-server.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "./support/test-database.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { installPrincipalLinks, UnattestableActor } from "../src/directory/person.ts";

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

test("mcp client lists every page of tools and calls one over JSON and SSE responses", async (t) => {
  const tools = ["a", "b", "c"].map((name) => ({
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object" as const },
  }));
  for (const json of [true, false]) {
    const mcp = await startMcpTestServer(t, { tools, pageSize: 1, json });
    const client = createMcpClient({ fetch: loopbackFetch, url: `${mcp.url}/mcp`, auth: { mode: "none" } });
    assert.deepEqual(await client.listTools(), {
      tools: [
        { name: "a", description: "tool a", inputSchema: { type: "object" } },
        { name: "b", description: "tool b", inputSchema: { type: "object" } },
        { name: "c", description: "tool c", inputSchema: { type: "object" } },
      ],
    });
    assert.equal(mcpResultText(await client.callTool("b", {})), "ran b");
    assert.equal(mcp.openSessions(), 0, "each operation ends its session");
  }
});

test("mcp client keeps the server's own description, else its instructions", async (t) => {
  const both = await startMcpTestServer(t, { description: "Track orders.", instructions: "Call search first." });
  const listed = await createMcpClient({ fetch: loopbackFetch, url: both.url, auth: { mode: "none" } }).listTools();
  assert.equal(listed.about, "Track orders.");
  const told = await startMcpTestServer(t, { instructions: "  Call search first.\nThen update.  " });
  const about = (await createMcpClient({ fetch: loopbackFetch, url: told.url, auth: { mode: "none" } }).listTools())
    .about;
  assert.equal(about, "Call search first.\nThen update.");
});

test("mcp client caps a server's tool list", async (t) => {
  const tools = Array.from({ length: 100 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" as const } }));
  const mcp = await startMcpTestServer(t, { tools, pageSize: 40 });
  const listed = (await createMcpClient({ fetch: loopbackFetch, url: mcp.url, auth: { mode: "none" } }).listTools())
    .tools;
  assert.equal(listed.length, 64);
  assert.equal(listed.at(-1)?.name, "t63");
  assert.equal(mcp.requests.filter((r) => r.rpc === "tools/list").length, 2);
});

test("mcp client surfaces tool errors and protocol errors", async (t) => {
  const mcp = await startMcpTestServer(t, {
    call: (name) => ({ isError: true, content: [{ type: "text", text: `${name} exploded` }] }),
  });
  const client = createMcpClient({ fetch: loopbackFetch, url: mcp.url, auth: { mode: "none" } });
  await assert.rejects(client.callTool("query", {}), /^Error: mcp tool query error: query exploded$/);
  await assert.rejects(
    client.callTool("missing", {}),
    (e: Error) => e.message === "mcp tools/call failed" && /Unknown tool: missing/.test(String(e.cause)),
  );
});

test("mcp client starts a fresh session after the server forgets its sessions", async (t) => {
  const mcp = await startMcpTestServer(t);
  const client = createMcpClient({ fetch: loopbackFetch, url: mcp.url, auth: { mode: "none" } });
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  await mcp.dropSessions();
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  assert.equal(mcp.requests.filter((r) => r.rpc === "initialize").length, 2);
});

test("mcp client sends bearer auth", async (t) => {
  const mcp = await startMcpTestServer(t, { authorize: (auth) => auth === "Bearer sekret" });
  const good = createMcpClient({ fetch: loopbackFetch, url: mcp.url, auth: { mode: "bearer", token: "sekret" } });
  assert.equal((await good.listTools()).tools.length, 2);
  const bad = createMcpClient({ fetch: loopbackFetch, url: mcp.url, auth: { mode: "none" } });
  await assert.rejects(bad.listTools(), /^Error: mcp tools\/list failed \(HTTP 401\)$/);
});

test("mcp client posts to the configured endpoint path", async (t) => {
  const mcp = await startMcpTestServer(t);
  const cases: Array<[string, string]> = [
    [`${mcp.url}/mcp/consumer`, "/mcp/consumer"],
    [`${mcp.url}/mcp/consumer/`, "/mcp/consumer"],
    [`${mcp.url}/mcp`, "/mcp"],
    [`${mcp.url}/mcp/`, "/mcp"],
    [mcp.url, "/mcp"],
    [`${mcp.url}/`, "/mcp"],
  ];
  for (const [url, expected] of cases) {
    mcp.requests.length = 0;
    await createMcpClient({ fetch: loopbackFetch, url, auth: { mode: "none" } }).listTools();
    assert.deepEqual([...new Set(mcp.requests.map((r) => r.path))], [expected], url);
  }
});

test("mcp client mints client-credentials tokens on the server's origin and reuses them until rejected", async (t) => {
  const mcp = await startMcpTestServer(t, { clients: { id: "secret" } });
  const client = createMcpClient({
    fetch: loopbackFetch,
    url: `${mcp.url}/mcp`,
    auth: { mode: "client-credentials", clientId: "id", clientSecret: "secret" },
  });
  assert.equal((await client.listTools()).tools.length, 2);
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  assert.deepEqual(mcp.tokenRequests, ["id"]);
  mcp.revokeTokens();
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  assert.equal(mcp.tokenRequests.length, 2);
  const wrong = createMcpClient({
    fetch: loopbackFetch,
    url: mcp.url,
    auth: { mode: "client-credentials", clientId: "id", clientSecret: "guess" },
  });
  await assert.rejects(wrong.listTools(), { code: "invalid_client", status: 401 });
});

test("mcp client never sends client credentials to an authorization server on another origin", async (t) => {
  const elsewhere = await startMcpTestServer(t, { clients: { id: "secret" } });
  const mcp = await startMcpTestServer(t, { clients: { id: "secret" }, authorizationServer: elsewhere.url });
  const client = createMcpClient({
    fetch: loopbackFetch,
    url: mcp.url,
    auth: { mode: "client-credentials", clientId: "id", clientSecret: "secret" },
  });
  await assert.rejects(client.listTools(), (e: Error) => /not presented to/.test(String(e.cause)));
  assert.deepEqual(elsewhere.tokenRequests, []);
  assert.deepEqual(mcp.tokenRequests, []);
});

test("server id validation", () => {
  assert.ok(isValidMcpServerId("salesforce"));
  assert.ok(isValidMcpServerId("crm-2"));
  assert.ok(!isValidMcpServerId("Nope"));
  assert.ok(!isValidMcpServerId("x"));
  assert.ok(!isValidMcpServerId("has space"));
});

test("tool service exposes namespaced tools and calls through", async (t) => {
  const mcp = await startMcpTestServer(t, { description: "CRM records" });
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, refreshIntervalMs: 3600_000 });
  await store.put(server({ url: `${mcp.url}/mcp` }));
  await service.refresh();
  const defs = await service.toolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ["crm_query", "crm_update"]);
  assert.ok(defs.every((d) => d.readOnly && d.serverAbout === "CRM records"));
  const out = await service.call("crm_query", { q: "hello" }, "internal:U1");
  assert.equal(out, "ran query");
  service.close();
});

test("destructive annotations mark MCP tools for approval unless the server overrides the policy", async (t) => {
  const mcp = await startMcpTestServer(t, {
    tools: [
      { name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: "drop", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
      { name: "plain", inputSchema: { type: "object" } },
    ],
  });
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, refreshIntervalMs: 3600_000 });
  const approvals = async (partial: Partial<McpServer>) => {
    await store.put(server({ url: mcp.url, ...partial }));
    await service.refresh();
    return Object.fromEntries((await service.toolDefs()).map((d) => [d.remoteName, d.needsApproval]));
  };
  assert.deepEqual(await approvals({}), { read: false, drop: true, plain: false });
  assert.deepEqual(await approvals({ approval: "all" }), { read: true, drop: true, plain: true });
  assert.deepEqual(await approvals({ approval: "none" }), { read: false, drop: false, plain: false });
  const readOnly = async (partial: Partial<McpServer>) => {
    await store.put(server({ url: mcp.url, ...partial }));
    await service.refresh();
    return Object.fromEntries((await service.toolDefs()).map((d) => [d.remoteName, d.readOnly]));
  };
  assert.deepEqual(await readOnly({ readOnly: false }), { read: true, drop: false, plain: false });
  assert.deepEqual(await readOnly({ readOnly: true }), { read: true, drop: true, plain: true });
  service.close();
});

test("a catalog server is one tool that searches, describes, and invokes as the attested person", async (t) => {
  const mcp = await startMcpTestServer(t, {
    tools: [
      { name: "find-record", description: "Find a record by name", inputSchema: { type: "object" } },
      {
        name: "send-message",
        description: "Send a message to a contact\nLong detail",
        inputSchema: { type: "object", properties: { to: { type: "string" } } },
        annotations: { destructiveHint: true },
      },
    ],
    call: (name, args) => ({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] }),
  });
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, refreshIntervalMs: 3600_000 });
  await store.put(server({ id: "records", name: "Records", url: mcp.url, catalog: true, attestActor: true }));
  await service.refresh();
  assert.deepEqual(
    (await service.toolDefs()).map((d) => [d.name, d.catalog]),
    [["records", true]],
  );
  assert.equal(mcp.requests.filter((r) => r.rpc === "tools/list").length, 0, "a catalog is listed per person on use");
  assert.equal(
    await service.call(
      "records",
      { operation: "search", query: "message" },
      "alice@example.com",
      undefined,
      "personal:alice@example.com",
    ),
    "- send-message (needs approval): Send a message to a contact",
  );
  assert.match(
    await service.call(
      "records",
      { operation: "describe", tool: "send-message" },
      "alice@example.com",
      undefined,
      "personal:alice@example.com",
    ),
    /"needsApproval":true/,
  );
  assert.equal(
    await service.needsApproval(
      "records",
      { operation: "invoke", tool: "send-message" },
      "alice@example.com",
      "personal:alice@example.com",
    ),
    true,
  );
  assert.equal(
    await service.needsApproval(
      "records",
      { operation: "invoke", tool: "find-record" },
      "alice@example.com",
      "personal:alice@example.com",
    ),
    false,
  );
  assert.equal(
    await service.needsApproval("records", { operation: "search" }, "alice@example.com", "personal:alice@example.com"),
    false,
  );
  await assert.rejects(
    service.needsApproval(
      "records",
      { operation: "invoke", tool: "send_message" },
      "alice@example.com",
      "personal:alice@example.com",
    ),
    /Unknown Records tool: send_message\. Search for it first/,
  );
  await assert.rejects(
    service.call(
      "records",
      { operation: "invoke", tool: "send-message", arguments: { to: "x" } },
      "alice@example.com",
      undefined,
      "personal:alice@example.com",
    ),
    /needs the person's approval/,
    "an approval-requiring tool never goes out without an approval",
  );
  assert.equal(
    await service.call(
      "records",
      { operation: "invoke", tool: "send-message", arguments: { to: "x" } },
      "alice@example.com",
      "tool-call:abc",
      "personal:alice@example.com",
    ),
    'send-message {"to":"x"}',
  );
  assert.deepEqual(
    mcp.requests.filter((r) => r.rpc === "tools/call").map((r) => [r.actor, r.approval]),
    [["alice@example.com", "tool-call:abc"]],
  );
  assert.equal(mcp.requests.filter((r) => r.rpc === "tools/list").length, 1, "the catalog is cached per person");
  await service.call("records", { operation: "search" }, "bob@example.com", undefined, "personal:bob@example.com");
  assert.equal(mcp.requests.filter((r) => r.rpc === "tools/list").length, 2, "each person gets their own catalog");
  assert.ok(mcp.requests.every((r) => r.actor === "alice@example.com" || r.actor === "bob@example.com"));
  await assert.rejects(
    service.call("records", { operation: "search" }),
    /answers only to them in their own private conversation/,
  );
  await service.refresh();
  const lists = mcp.requests.filter((r) => r.rpc === "tools/list").length;
  await Promise.all([
    service.call("records", { operation: "search" }, "alice@example.com", undefined, "personal:alice@example.com"),
    service.call("records", { operation: "search" }, "alice@example.com", undefined, "personal:alice@example.com"),
  ]);
  assert.equal(
    mcp.requests.filter((r) => r.rpc === "tools/list").length,
    lists + 1,
    "refresh drops the cache and parallel lookups share one listing",
  );
  service.close();
});

test("an attested connector is offered only to its person in their own private conversation", async (t) => {
  const mcp = await startMcpTestServer(t, {
    tools: [{ name: "find-record", description: "Find a record", inputSchema: { type: "object" } }],
  });
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, refreshIntervalMs: 3600_000 });
  await store.put(server({ id: "records", name: "Records", url: mcp.url, catalog: true, attestActor: true }));
  await service.refresh();
  const offered = async (principalId: string, scopeId: string) =>
    (await service.toolDefsFor(principalId, scopeId)).map((d) => d.serverId);
  assert.deepEqual(await offered("U1", "personal:U1"), ["records"]);
  assert.deepEqual(await offered("U2", "personal:U1"), []);
  assert.deepEqual(await offered("system:ambient:acme", "personal:system:ambient:acme"), []);
  assert.deepEqual(await offered("U1", "channel:C1"), []);
  service.close();
});

test("an attested connector refuses a call outside its person's own conversation even before this instance refreshes", async (t) => {
  const mcp = await startMcpTestServer(t, {
    tools: [{ name: "find-record", description: "Find a record", inputSchema: { type: "object" } }],
  });
  const shared = testMap<McpServer>();
  const otherInstance = createMcpServerStore(shared);
  const store = createMcpServerStore(shared);
  const audit = createPostgresAuditLog(testDatabaseUrl());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, audit, refreshIntervalMs: 3600_000 });
  const records = server({ id: "records", name: "Records", url: mcp.url, catalog: true });
  await store.put(records);
  await service.refresh();
  assert.deepEqual(
    (await service.toolDefsFor("U1", "channel:C1")).map((d) => d.serverId),
    ["records"],
  );
  await otherInstance.put({ ...records, attestActor: true, updatedAt: 1 });
  const invoke = { operation: "invoke", tool: "find-record", arguments: {} };
  const privateOnly = /answers only to them in their own private conversation/;
  await assert.rejects(service.needsApproval("records", invoke, "U1", "channel:C1"), privateOnly);
  await assert.rejects(service.call("records", invoke, "U1", undefined, "channel:C1"), privateOnly);
  await assert.rejects(service.call("records", invoke, "U2", undefined, "personal:U1"), privateOnly);
  assert.equal(mcp.requests.length, 0);
  assert.deepEqual(
    (await audit.tail({ limit: 10, action: "mcp.call", resourceContains: "records" }))
      .filter((event) => privateOnly.test(event.status ?? ""))
      .map((event) => event.principalId)
      .sort(),
    ["U1", "U1", "U2"],
  );
  await service.call("records", invoke, "U1", undefined, "personal:U1");
  assert.deepEqual(
    mcp.requests.filter((r) => r.rpc === "tools/call").map((r) => r.actor),
    ["U1"],
  );
  service.close();
});

test("attested connectors send one canonical person and never call for an actor QM can't attest", async (t) => {
  installPrincipalLinks({
    canonical: (key) => (["alice@example.com", "U_ALICE", "system:digest"].includes(key) ? "U_ALICE" : undefined),
    aliases: () => [],
  });
  t.after(() => installPrincipalLinks(null));
  const mcp = await startMcpTestServer(t, {
    tools: [{ name: "find-record", description: "Find a record", inputSchema: { type: "object" } }],
  });
  const store = createMcpServerStore(testMap<McpServer>());
  const audit = createPostgresAuditLog(testDatabaseUrl());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, audit, refreshIntervalMs: 3600_000 });
  await store.put(server({ id: "records", name: "Records", url: mcp.url, catalog: true, attestActor: true }));
  await service.refresh();
  for (const person of ["alice@example.com", "U_ALICE"])
    await service.call(
      "records",
      { operation: "invoke", tool: "find-record", arguments: {} },
      person,
      undefined,
      `personal:${person}`,
    );
  assert.ok(mcp.requests.length > 0);
  assert.deepEqual(new Set(mcp.requests.map((request) => request.actor)), new Set(["U_ALICE"]));
  const sent = mcp.requests.length;
  await assert.rejects(
    service.call("records", { operation: "search" }, "system:digest", undefined, "personal:U_ALICE"),
    /answers only to them in their own private conversation/,
  );
  for (const person of ["jörg@example.com", "x".repeat(257)])
    await assert.rejects(
      service.call("records", { operation: "search" }, person, undefined, `personal:${person}`),
      (error: unknown) => error instanceof UnattestableActor && /POST \/v1\/admin\/principal-links/.test(error.message),
    );
  assert.equal(mcp.requests.length, sent);
  assert.equal(
    (await audit.tail({ limit: 10, action: "mcp.call", resourceContains: "records" })).filter((event) =>
      /principal-links/.test(event.status ?? ""),
    ).length,
    2,
  );
  service.close();
});

test("disabled server's tools disappear and calls fail", async (t) => {
  const mcp = await startMcpTestServer(t);
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, refreshIntervalMs: 3600_000 });
  await store.put(server({ url: mcp.url }));
  await service.refresh();
  assert.equal((await service.toolDefs()).length, 2);
  await store.put(server({ url: mcp.url, enabled: false }));
  await service.refresh();
  assert.equal((await service.toolDefs()).length, 0);
  service.close();
});

test("unknown tool call rejects", async () => {
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool/);
  service.close();
});

function tokenStore() {
  return createKeychain({
    lock: testAdvisoryLock(),
    creds: testMap<KeychainCredential>(),
    grants: testMap(),
    asks: testMap(),
    key: deriveConnectorKey("mcp-test-encryption-key"),
  });
}

test("per-user calls resolve only the caller's fresh token while discovery uses catalog auth", async (t) => {
  const mcp = await startMcpTestServer(t, {
    call: (_name, args) => ({ content: [{ type: "text", text: String(args.q) }] }),
  });
  const store = createMcpServerStore(testMap<McpServer>());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "alice-token" });
  await users.setConnectorToken(host, "internal:bob", { accessToken: "bob-token" });
  const authFor = (rpc: string) => mcp.requests.filter((r) => r.rpc === rpc).map((r) => r.authorization);
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, userTokens: users });
  t.after(() => service.close());
  await store.put(
    server({
      url: mcp.url,
      auth: "bearer",
      bearerToken: "catalog-only",
      credentialScope: "per-user",
      credentialHost: host,
    }),
  );
  await service.refresh();
  assert.deepEqual(
    (await service.probe((await store.get("crm"))!)).tools.map((tool) => tool.name),
    ["query", "update"],
  );
  assert.ok(authFor("tools/list").length > 0);
  assert.ok(authFor("tools/list").every((auth) => auth === "Bearer catalog-only"));
  assert.deepEqual(
    await Promise.all([
      service.call("crm_query", { q: "alice" }, "internal:alice"),
      service.call("crm_query", { q: "bob" }, "internal:bob"),
    ]),
    ["alice", "bob"],
  );
  assert.deepEqual(authFor("tools/call").sort(), ["Bearer alice-token", "Bearer bob-token"]);
  await users.setConnectorToken(host, "internal:alice", { accessToken: "rotated-alice" });
  await service.call("crm_query", { q: "rotated" }, "internal:alice");
  assert.equal(authFor("tools/call").at(-1), "Bearer rotated-alice");
  await users.deleteConnectorToken(host, "internal:alice");
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /Connect your account/);
  await assert.rejects(service.call("crm_query", {}), /requires a connected user/);
  await assert.rejects(
    service.call("crm_query", { principalId: "internal:bob" }, "internal:mallory"),
    /Connect your account/,
  );
  await users.setConnectorToken(host, "internal:bob", { accessToken: "expired", expiresAt: 1 });
  await assert.rejects(service.call("crm_query", {}, "internal:bob"), /Connect your account/);
  assert.equal(authFor("tools/call").length, 3);
});

test("per-user mode fails closed without a keychain and shared mode preserves existing behavior", async (t) => {
  const mcp = await startMcpTestServer(t, { authorize: (auth) => auth === "Bearer shared-token" });
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store });
  t.after(() => service.close());
  await store.put(
    server({
      url: mcp.url,
      auth: "bearer",
      bearerToken: "shared-token",
      credentialScope: "per-user",
      credentialHost: "accounts.example.com",
    }),
  );
  await service.refresh();
  const calls = () => mcp.requests.filter((r) => r.rpc === "tools/call").length;
  const count = calls();
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /requires a connected user/);
  assert.equal(calls(), count);
  await store.put(server({ url: mcp.url, auth: "bearer", bearerToken: "shared-token", credentialScope: "shared" }));
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
    fetch: loopbackFetch,
    url: `http://127.0.0.1:${(redirected.address() as AddressInfo).port}`,
    auth: { mode: "bearer", token: "private-user-token" },
  });
  await assert.rejects(client.callTool("query", {}));
  assert.equal(targetRequests, 0);
});

test("per-user connectors select an explicit account slot without falling back to another slot", async (t) => {
  const store = createMcpServerStore(testMap<McpServer>());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "default-token" });
  await users.setConnectorToken(host, "internal:alice", { accessToken: "company-token" }, "company");
  const mcp = await startMcpTestServer(t, { authorize: (auth) => auth === "Bearer company-token" });
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, userTokens: users });
  t.after(() => service.close());
  await store.put(
    server({
      url: mcp.url,
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

test("MCP refresh contains registry failures on change and on a stale read, then recovers", async (t) => {
  const backing = testMap<McpServer>();
  const store = createMcpServerStore(backing);
  const mcp = await startMcpTestServer(t);
  const list = t.mock.method(store, "list", async () => {
    throw new Error("registry unavailable");
  });
  const errors = t.mock.method(console, "error", () => {});
  let clock = 1_000;
  const service = createMcpToolService({
    fetch: loopbackFetch,
    servers: store,
    refreshIntervalMs: 100,
    now: () => clock,
  });
  t.after(() => service.close());
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  await tick();
  assert.equal(list.mock.callCount(), 0);
  await store.put(server({ url: mcp.url }));
  await tick();
  assert.equal(list.mock.callCount(), 1);
  assert.deepEqual(await service.toolDefs(), []);
  assert.equal(list.mock.callCount(), 1);
  clock += 100;
  await service.toolDefs();
  await tick();
  assert.equal(list.mock.callCount(), 2);
  assert.equal(errors.mock.callCount(), 2);
  await assert.rejects(service.refresh(), /registry unavailable/);
  list.mock.restore();
  clock += 100;
  await settle(async () => (await service.toolDefs()).length > 0);
  assert.deepEqual(
    (await service.toolDefs()).map((tool) => tool.name),
    ["crm_query", "crm_update"],
  );
  assert.equal(await service.call("crm_query", {}), "ran query");
});

test("optional intent and locale parameters are left out of the schema the model sees, required ones are kept", async (t) => {
  const store = createMcpServerStore(testMap<McpServer>());
  const sent: Array<Record<string, unknown>> = [];
  const mcp = await startMcpTestServer(t, {
    tools: [
      {
        name: "search",
        description: "Search",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            intent: { type: "string", description: "Why this call is made; logged for analytics." },
            locale: { type: "string", description: "Language tag." },
          },
          required: ["query"],
        },
      },
      {
        name: "translate",
        description: "Translate",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" }, locale: { type: "string" } },
          required: ["text", "locale"],
        },
      },
    ],
    call: (_name, args) => {
      sent.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store });
  t.after(() => service.close());
  await store.put(server({ url: `${mcp.url}/mcp` }));
  await service.refresh();
  const schemas = Object.fromEntries((await service.toolDefs()).map((d) => [d.name, d.inputSchema]));
  assert.deepEqual(Object.keys(schemas.crm_search!.properties as object), ["query"]);
  assert.deepEqual(schemas.crm_search!.required, ["query"]);
  assert.deepEqual(Object.keys(schemas.crm_translate!.properties as object), ["text", "locale"]);
  assert.equal(await service.call("crm_search", { query: "tacos" }), "ok");
  assert.deepEqual(sent, [{ query: "tacos" }]);
});

test("a connector set to attest in any audience acts as the signed-in person who asked, wherever they ask, and never for anyone else", async (t) => {
  const mcp = await startMcpTestServer(t, {
    tools: [{ name: "find-record", description: "Find a record", inputSchema: { type: "object" } }],
  });
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, refreshIntervalMs: 3600_000 });
  const attested = { url: mcp.url, catalog: true, attestActor: true } as const;
  await store.put(server({ id: "records", name: "Records", ...attested, attestAudience: "any" }));
  await store.put(server({ id: "strict", name: "Strict", ...attested }));
  await service.refresh();
  const offered = async (principalId: string, scopeId: string, actAsActor?: boolean) =>
    (await service.toolDefsFor(principalId, scopeId, actAsActor)).map((d) => d.serverId).sort();
  assert.deepEqual(await offered("U1", "personal:U1"), ["records", "strict"]);
  assert.deepEqual(await offered("U1", "channel:C1", true), ["records"]);
  assert.deepEqual(await offered("U1", "group:G1", true), ["records"]);
  assert.deepEqual(await offered("G9", "channel:C1", false), []);
  assert.deepEqual(await offered("U1", "channel:C1"), []);
  assert.deepEqual(await offered("system:channel:C1", "channel:C1", true), []);

  const invoke = { operation: "invoke", tool: "find-record", arguments: {} };
  const privateOnly = /answers only to them in their own private conversation/;
  assert.equal(await service.needsApproval("records", invoke, "U1", "channel:C1", true), false);
  await service.call("records", invoke, "U1", undefined, "channel:C1", true);
  await service.call("records", invoke, "U2", undefined, "personal:U1", true);
  await assert.rejects(service.call("records", invoke, "G9", undefined, "channel:C1", false), privateOnly);
  await assert.rejects(service.call("records", invoke, "U1", undefined, "channel:C1"), privateOnly);
  await assert.rejects(
    service.call("records", invoke, "system:channel:C1", undefined, "channel:C1", true),
    privateOnly,
  );
  await assert.rejects(
    service.call("records", invoke, "jörg@example.com", undefined, "channel:C1", true),
    (error: unknown) => error instanceof UnattestableActor,
  );
  await assert.rejects(service.call("strict", invoke, "U1", undefined, "channel:C1", true), privateOnly);
  assert.deepEqual(
    mcp.requests.filter((r) => r.rpc === "tools/call").map((r) => r.actor),
    ["U1", "U2"],
  );
  service.close();
});
