import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import {
  authorizeUrl,
  exchangeCode,
  makeRefresh,
  oauthProvider,
  setPublicOAuthClients,
  withPublicOAuthClients,
} from "../../src/connectors/oauth.ts";
import { createKeychain } from "../../src/credentials/create-keychain.ts";
import { createMcpClient, mcpResultText } from "../../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../../src/mcp/mcp-server-store.ts";
import { createMcpToolService, mcpPublicOAuthClients } from "../../src/mcp/mcp-tool-service.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";
import { settle } from "../support/settle.ts";
import { startMcpTestServer } from "../support/mcp-test-server.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";

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
    const client = createMcpClient({ url: `${mcp.url}/mcp`, auth: { mode: "none" } });
    assert.deepEqual(await client.listTools(), [
      { name: "a", description: "tool a", inputSchema: { type: "object" } },
      { name: "b", description: "tool b", inputSchema: { type: "object" } },
      { name: "c", description: "tool c", inputSchema: { type: "object" } },
    ]);
    assert.equal(mcpResultText(await client.callTool("b", {})), "ran b");
    assert.equal(mcp.openSessions(), 0, "each operation ends its session");
  }
});

test("mcp client caps a server's tool list", async (t) => {
  const tools = Array.from({ length: 100 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" as const } }));
  const mcp = await startMcpTestServer(t, { tools, pageSize: 40 });
  const listed = await createMcpClient({ url: mcp.url, auth: { mode: "none" } }).listTools();
  assert.equal(listed.length, 64);
  assert.equal(listed.at(-1)?.name, "t63");
  assert.equal(mcp.requests.filter((r) => r.rpc === "tools/list").length, 2);
});

test("mcp client surfaces tool errors and protocol errors", async (t) => {
  const mcp = await startMcpTestServer(t, {
    call: (name) => ({ isError: true, content: [{ type: "text", text: `${name} exploded` }] }),
  });
  const client = createMcpClient({ url: mcp.url, auth: { mode: "none" } });
  await assert.rejects(client.callTool("query", {}), /^Error: mcp tool query error: query exploded$/);
  await assert.rejects(
    client.callTool("missing", {}),
    (e: Error) => e.message === "mcp tools/call failed" && /Unknown tool: missing/.test(String(e.cause)),
  );
});

test("mcp client starts a fresh session after the server forgets its sessions", async (t) => {
  const mcp = await startMcpTestServer(t);
  const client = createMcpClient({ url: mcp.url, auth: { mode: "none" } });
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  await mcp.dropSessions();
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  assert.equal(mcp.requests.filter((r) => r.rpc === "initialize").length, 2);
});

test("mcp client sends bearer auth", async (t) => {
  const mcp = await startMcpTestServer(t, { authorize: (auth) => auth === "Bearer sekret" });
  const good = createMcpClient({ url: mcp.url, auth: { mode: "bearer", token: "sekret" } });
  assert.equal((await good.listTools()).length, 2);
  const bad = createMcpClient({ url: mcp.url, auth: { mode: "none" } });
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
    await createMcpClient({ url, auth: { mode: "none" } }).listTools();
    assert.deepEqual([...new Set(mcp.requests.map((r) => r.path))], [expected], url);
  }
});

test("mcp client mints client-credentials tokens on the server's origin and reuses them until rejected", async (t) => {
  const mcp = await startMcpTestServer(t, { clients: { id: "secret" } });
  const client = createMcpClient({
    url: `${mcp.url}/mcp`,
    auth: { mode: "client-credentials", clientId: "id", clientSecret: "secret" },
  });
  assert.equal((await client.listTools()).length, 2);
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  assert.deepEqual(mcp.tokenRequests, ["id"]);
  mcp.revokeTokens();
  assert.equal(mcpResultText(await client.callTool("query", {})), "ran query");
  assert.equal(mcp.tokenRequests.length, 2);
  const wrong = createMcpClient({
    url: mcp.url,
    auth: { mode: "client-credentials", clientId: "id", clientSecret: "guess" },
  });
  await assert.rejects(wrong.listTools());
});

test("mcp client never sends client credentials to an authorization server on another origin", async (t) => {
  const elsewhere = await startMcpTestServer(t, { clients: { id: "secret" } });
  const mcp = await startMcpTestServer(t, { clients: { id: "secret" }, authorizationServer: elsewhere.url });
  const client = createMcpClient({
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
  const mcp = await startMcpTestServer(t);
  const store = createMcpServerStore(testDatabaseUrl());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await store.put(server({ url: `${mcp.url}/mcp` }));
  await service.refresh();
  const defs = service.toolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ["crm_query", "crm_update"]);
  assert.ok(defs.every((d) => d.readOnly));
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
  const store = createMcpServerStore(testDatabaseUrl());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  const approvals = async (partial: Partial<McpServer>) => {
    await store.put(server({ url: mcp.url, ...partial }));
    await service.refresh();
    return Object.fromEntries(service.toolDefs().map((d) => [d.remoteName, d.needsApproval]));
  };
  assert.deepEqual(await approvals({}), { read: false, drop: true, plain: false });
  assert.deepEqual(await approvals({ approval: "all" }), { read: true, drop: true, plain: true });
  assert.deepEqual(await approvals({ approval: "none" }), { read: false, drop: false, plain: false });
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
  const store = createMcpServerStore(testDatabaseUrl());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await store.put(server({ id: "records", name: "Records", url: mcp.url, catalog: true, attestActor: true }));
  await service.refresh();
  assert.deepEqual(
    service.toolDefs().map((d) => [d.name, d.catalog]),
    [["records", true]],
  );
  assert.equal(mcp.requests.filter((r) => r.rpc === "tools/list").length, 0, "a catalog is listed per person on use");
  assert.equal(
    await service.call("records", { operation: "search", query: "message" }, "alice@example.com"),
    "- send-message (needs approval): Send a message to a contact",
  );
  assert.match(
    await service.call("records", { operation: "describe", tool: "send-message" }, "alice@example.com"),
    /"needsApproval":true/,
  );
  assert.equal(
    await service.needsApproval("records", { operation: "invoke", tool: "send-message" }, "alice@example.com"),
    true,
  );
  assert.equal(
    await service.needsApproval("records", { operation: "invoke", tool: "find-record" }, "alice@example.com"),
    false,
  );
  assert.equal(await service.needsApproval("records", { operation: "search" }, "alice@example.com"), false);
  await assert.rejects(
    service.needsApproval("records", { operation: "invoke", tool: "send_message" }, "alice@example.com"),
    /Unknown Records tool: send_message\. Search for it first/,
  );
  await assert.rejects(
    service.call("records", { operation: "invoke", tool: "send-message", arguments: { to: "x" } }, "alice@example.com"),
    /needs the person's approval/,
    "an approval-requiring tool never goes out without an approval",
  );
  assert.equal(
    await service.call(
      "records",
      { operation: "invoke", tool: "send-message", arguments: { to: "x" } },
      "alice@example.com",
      "tool-call:abc",
    ),
    'send-message {"to":"x"}',
  );
  assert.deepEqual(
    mcp.requests.filter((r) => r.rpc === "tools/call").map((r) => [r.actor, r.approval]),
    [["alice@example.com", "tool-call:abc"]],
  );
  assert.equal(mcp.requests.filter((r) => r.rpc === "tools/list").length, 1, "the catalog is cached per person");
  await service.call("records", { operation: "search" }, "bob@example.com");
  assert.equal(mcp.requests.filter((r) => r.rpc === "tools/list").length, 2, "each person gets their own catalog");
  assert.ok(mcp.requests.every((r) => r.actor === "alice@example.com" || r.actor === "bob@example.com"));
  await assert.rejects(service.call("records", { operation: "search" }), /needs a signed-in person/);
  await service.refresh();
  const lists = mcp.requests.filter((r) => r.rpc === "tools/list").length;
  await Promise.all([
    service.call("records", { operation: "search" }, "alice@example.com"),
    service.call("records", { operation: "search" }, "alice@example.com"),
  ]);
  assert.equal(
    mcp.requests.filter((r) => r.rpc === "tools/list").length,
    lists + 1,
    "refresh drops the cache and parallel lookups share one listing",
  );
  service.close();
});

test("disabled server's tools disappear and calls fail", async (t) => {
  const mcp = await startMcpTestServer(t);
  const store = createMcpServerStore(testDatabaseUrl());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await store.put(server({ url: mcp.url }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 2);
  await store.put(server({ url: mcp.url, enabled: false }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 0);
  service.close();
});

test("unknown tool call rejects", async () => {
  const store = createMcpServerStore(testDatabaseUrl());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool/);
  service.close();
});

function tokenStore() {
  return createKeychain({
    lock: testAdvisoryLock(),
    store: createKeychainStore(testDatabaseUrl()),
    key: deriveConnectorKey("mcp-test-encryption-key"),
  });
}

test("per-user calls resolve only the caller's fresh token while discovery uses catalog auth", async (t) => {
  const mcp = await startMcpTestServer(t, {
    call: (_name, args) => ({ content: [{ type: "text", text: String(args.q) }] }),
  });
  const store = createMcpServerStore(testDatabaseUrl());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "alice-token" });
  await users.setConnectorToken(host, "internal:bob", { accessToken: "bob-token" });
  const authFor = (rpc: string) => mcp.requests.filter((r) => r.rpc === rpc).map((r) => r.authorization);
  const service = createMcpToolService({ servers: store, userTokens: users });
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
  assert.deepEqual(await service.probe((await store.get("crm"))!), ["query", "update"]);
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
  const store = createMcpServerStore(testDatabaseUrl());
  const service = createMcpToolService({ servers: store });
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
    url: `http://127.0.0.1:${(redirected.address() as AddressInfo).port}`,
    auth: { mode: "bearer", token: "private-user-token" },
  });
  await assert.rejects(client.callTool("query", {}));
  assert.equal(targetRequests, 0);
});

test("per-user connectors select an explicit account slot without falling back to another slot", async (t) => {
  const store = createMcpServerStore(testDatabaseUrl());
  const users = tokenStore();
  const host = "accounts.example.com";
  await users.setConnectorToken(host, "internal:alice", { accessToken: "default-token" });
  await users.setConnectorToken(host, "internal:alice", { accessToken: "company-token" }, "company");
  const mcp = await startMcpTestServer(t, { authorize: (auth) => auth === "Bearer company-token" });
  const service = createMcpToolService({ servers: store, userTokens: users });
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

test("background MCP refresh contains registry failures at startup, on change, and when read stale", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const store = createMcpServerStore(testDatabaseUrl());
  const mcp = await startMcpTestServer(t);
  const list = t.mock.method(store, "list", async () => {
    throw new Error("registry unavailable");
  });
  const errors = t.mock.method(console, "error", () => {});
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 100 });
  t.after(() => service.close());
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  await tick();
  assert.equal(list.mock.callCount(), 1);
  await store.put(server({ url: mcp.url }));
  await tick();
  assert.equal(list.mock.callCount(), 2);
  t.mock.timers.tick(100);
  service.toolDefs();
  await tick();
  assert.equal(list.mock.callCount(), 3);
  assert.equal(errors.mock.callCount(), 3);
  await assert.rejects(service.refresh(), /registry unavailable/);
  list.mock.restore();
  t.mock.timers.tick(100);
  await settle(async () => service.toolDefs().length > 0);
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.name),
    ["crm_query", "crm_update"],
  );
  assert.equal(await service.call("crm_query", {}), "ran query");
});

test("optional intent and locale parameters are left out of the schema the model sees, required ones are kept", async (t) => {
  const store = createMcpServerStore(testDatabaseUrl());
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
  const service = createMcpToolService({ servers: store });
  t.after(() => service.close());
  await store.put(server({ url: `${mcp.url}/mcp` }));
  await service.refresh();
  const schemas = Object.fromEntries(service.toolDefs().map((d) => [d.name, d.inputSchema]));
  assert.deepEqual(Object.keys(schemas.crm_search!.properties as object), ["query"]);
  assert.deepEqual(schemas.crm_search!.required, ["query"]);
  assert.deepEqual(Object.keys(schemas.crm_translate!.properties as object), ["text", "locale"]);
  assert.equal(await service.call("crm_search", { query: "tacos" }), "ok");
  assert.deepEqual(sent, [{ query: "tacos" }]);
});

const HOST = "mcp.example.com";

function oauthServer(partial?: Partial<McpServer>): McpServer {
  return {
    id: "orders",
    name: "Orders",
    url: `https://${HOST}/mcp`,
    auth: "oauth-user",
    credentialScope: "per-user",
    credentialHost: HOST,
    clientId: "public-client",
    oauthAuthorizeUrl: "https://id.example.com/authorize",
    oauthTokenUrl: "https://id.example.com/token",
    oauthScopes: ["mcp:write"],
    readOnly: false,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
    ...partial,
  };
}

test("oauth-user servers register a PKCE public client that exchanges and refreshes without a secret", async (t) => {
  t.after(() => setPublicOAuthClients([]));
  setPublicOAuthClients(mcpPublicOAuthClients([oauthServer(), oauthServer({ id: "off", enabled: false })]));
  assert.ok(oauthProvider("orders")?.pkce);
  assert.equal(oauthProvider("off"), undefined);
  const resolve = withPublicOAuthClients(async () => {
    throw new Error("secret resolver must not be used");
  });
  const client = await resolve("orders", {});
  assert.equal(client.secret, "");
  const consent = new URL(
    authorizeUrl("orders", { redirectUri: "https://qm/cb", state: "s", client, codeChallenge: "cc" }),
  );
  assert.equal(consent.origin + consent.pathname, "https://id.example.com/authorize");
  assert.equal(consent.searchParams.get("client_id"), "public-client");
  assert.equal(consent.searchParams.get("scope"), "mcp:write");
  assert.equal(consent.searchParams.get("code_challenge_method"), "S256");
  assert.equal(consent.searchParams.get("resource"), `https://${HOST}/mcp`);

  const bodies: URLSearchParams[] = [];
  const fetchImpl = async (_url: string, init: { body: string }) => {
    bodies.push(new URLSearchParams(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: `a${bodies.length}`, refresh_token: "r", expires_in: 60 }),
    };
  };
  const { hosts, token } = await exchangeCode("orders", "code", "https://qm/cb", {
    client,
    fetchImpl,
    codeVerifier: "v",
  });
  assert.deepEqual(hosts, [HOST]);
  assert.equal(token.accessToken, "a1");
  const fresh = await makeRefresh({ resolveClient: resolve, fetchImpl })(HOST, token);
  assert.equal(fresh.accessToken, "a2");
  for (const b of bodies) {
    assert.equal(b.get("client_id"), "public-client");
    assert.equal(b.has("client_secret"), false);
  }
  assert.equal(bodies[0]!.get("code_verifier"), "v");
  for (const b of bodies) assert.equal(b.get("resource"), `https://${HOST}/mcp`);

  setPublicOAuthClients([]);
  assert.equal(oauthProvider("orders"), undefined);
  setPublicOAuthClients(mcpPublicOAuthClients([oauthServer({ id: "github", credentialHost: "x.example" })]));
  assert.notEqual(oauthProvider("github")?.pkce, true, "built-in providers are never shadowed");
});

test("oauth-user tools offer a sign-in link until the caller connects, then use only their token", async (t) => {
  const store = createMcpServerStore(testDatabaseUrl());
  const tokens = new Map<string, string>();
  const mcp = await startMcpTestServer(t, {
    tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
    call: (_name, args) => ({ content: [{ type: "text", text: `found ${String(args.q)}` }] }),
  });
  const auth = () => mcp.requests.filter((r) => r.rpc?.startsWith("tools/")).map((r) => r.authorization ?? "");
  const service = createMcpToolService({
    servers: store,
    userTokens: {
      connectorAccessToken: async (_host, principalId) => tokens.get(principalId) ?? null,
      connectorTokenStatus: async (_host, principalId) => ({ connected: tokens.has(principalId) }),
    },
    signInUrl: (id) => `https://qm.example/connect/${id}/self-connect`,
  });
  t.after(() => {
    service.close();
    setPublicOAuthClients([]);
  });
  await store.put(oauthServer({ url: `${mcp.url}/mcp` }));
  await service.refresh();
  assert.ok(oauthProvider("orders")?.pkce, "refresh registers the server's OAuth client");
  assert.deepEqual(
    (await service.toolDefsFor("internal:alice")).map((d) => d.name),
    ["orders_sign_in"],
  );
  assert.equal(mcp.requests.length, 0, "no unauthenticated discovery");
  assert.match(
    await service.call("orders_sign_in", {}, "internal:alice"),
    /\[Connect Orders\]\(https:\/\/qm\.example\/connect\/orders\/self-connect\)/,
  );

  tokens.set("internal:alice", "alice-token");
  assert.match(await service.call("orders_sign_in", {}, "internal:alice"), /orders_search/);
  assert.deepEqual(
    (await service.toolDefsFor("internal:alice")).map((d) => d.name),
    ["orders_search"],
  );
  assert.deepEqual(
    (await service.toolDefsFor("internal:bob")).map((d) => d.name),
    ["orders_sign_in"],
    "a teammate who has not connected sees only the sign-in tool, not the tools another person loaded",
  );
  assert.deepEqual(
    (await store.get("orders"))!.tools?.map((tool) => tool.name),
    ["search"],
    "learned tools are stored with the server so every instance and restart sees them",
  );
  assert.equal(await service.call("orders_search", { q: "tacos" }, "internal:alice"), "found tacos");
  assert.match(await service.call("orders_search", { q: "x" }, "internal:bob"), /Connect Orders/);
  assert.deepEqual(auth(), ["Bearer alice-token", "Bearer alice-token"]);
});

test("stored oauth-user tools survive a restart but stay hidden from callers whose connection needs repair", async (t) => {
  const store = createMcpServerStore(testDatabaseUrl());
  await store.put(oauthServer({ tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] }));
  const statuses: Record<string, { connected: boolean; needsReconnect?: boolean }> = {
    "internal:alice": { connected: true },
    "internal:carol": { connected: true, needsReconnect: true },
  };
  const service = createMcpToolService({
    servers: store,
    userTokens: {
      connectorAccessToken: async () => null,
      connectorTokenStatus: async (_host, principalId) => statuses[principalId] ?? { connected: false },
    },
  });
  t.after(() => {
    service.close();
    setPublicOAuthClients([]);
  });
  await service.refresh();
  assert.deepEqual(
    (await service.toolDefsFor("internal:alice")).map((d) => d.name),
    ["orders_search"],
  );
  assert.deepEqual(
    (await service.toolDefsFor("internal:carol")).map((d) => d.name),
    ["orders_sign_in"],
  );
  assert.deepEqual(
    (await service.toolDefsFor("internal:dave")).map((d) => d.name),
    ["orders_sign_in"],
  );
});
