import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpClient, mcpResultText } from "../src/mcp/mcp-client.ts";
import { createMcpServerStore, isValidMcpServerId, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createServer, request, type ServerResponse } from "node:http";
import { once } from "node:events";
import { sleep } from "../src/util/async.ts";
import type { AddressInfo } from "node:net";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { settle } from "./support/settle.ts";
import { startMcpTestServer } from "./support/mcp-test-server.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

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
  const listed = await createMcpClient({ url: both.url, auth: { mode: "none" } }).listTools();
  assert.equal(listed.about, "Track orders.");
  assert.equal(listed.instructions, "Call search first.");
  const told = await startMcpTestServer(t, { instructions: "  Call search first.\nThen update.  " });
  const { about, instructions } = await createMcpClient({ url: told.url, auth: { mode: "none" } }).listTools();
  assert.equal(about, "Call search first.\nThen update.");
  assert.equal(instructions, "Call search first.\nThen update.");
});

test("mcp client caps a server's tool list", async (t) => {
  const tools = Array.from({ length: 100 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" as const } }));
  const mcp = await startMcpTestServer(t, { tools, pageSize: 40 });
  const listed = (await createMcpClient({ url: mcp.url, auth: { mode: "none" } }).listTools()).tools;
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
  assert.equal((await good.listTools()).tools.length, 2);
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
  assert.equal((await client.listTools()).tools.length, 2);
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
  const mcp = await startMcpTestServer(t, { description: "CRM records" });
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await store.put(server({ url: `${mcp.url}/mcp` }));
  await service.refresh();
  const defs = service.toolDefs();
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
  const store = createMcpServerStore(createMemoryMap<McpServer>());
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
  const store = createMcpServerStore(createMemoryMap<McpServer>());
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

const ACME_INSTRUCTIONS =
  "Acme: search and run Acme tools.\n\nSkills (Acme playbooks): when a request matches one, read it with the read_skill tool before acting, then follow it.\n- party-setup: Party setup procedure. Use when setting up a casual social event.";

async function catalogService(
  t: Parameters<typeof startMcpTestServer>[0],
  mcpUrl: string,
  id = "acme",
  now?: () => number,
) {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000, ...(now ? { now } : {}) });
  t.after(async () => service.close());
  await store.put(server({ id, name: "Acme", url: mcpUrl, catalog: true, attestActor: true }));
  await service.refresh();
  return service;
}

test("a catalog server's instructions reach each person through its tool description", async (t) => {
  const mcp = await startMcpTestServer(t, {
    instructions: (actor) => (actor === "bob@example.com" ? "Bob's private note." : ACME_INSTRUCTIONS),
  });
  const service = await catalogService(t, mcp.url);
  const plain = service.toolDefs()[0]!;
  const [alice] = await service.toolDefsFor("alice@example.com");
  assert.equal(alice!.description, `${plain.description}\n\nFrom the Acme server:\n${ACME_INSTRUCTIONS}`);
  assert.deepEqual({ ...alice, description: plain.description }, plain);
  const [bob] = await service.toolDefsFor("bob@example.com");
  assert.equal(bob!.description, `${plain.description}\n\nFrom the Acme server:\nBob's private note.`);
  assert.deepEqual(await service.toolDefsFor("alice@example.com"), [alice]);
  assert.equal(mcp.requests.filter((r) => r.rpc === "tools/list").length, 2, "one listing per person");
  assert.equal(plain.description, service.toolDefs()[0]!.description, "the shared snapshot stays plain");
  assert.deepEqual(await service.toolDefsFor(), service.toolDefs(), "no attested person, no instructions");
});

test("a catalog's last-known instructions serve the turn while a stale listing refreshes behind it", async (t) => {
  let version = 1;
  let clock = 1_000;
  const mcp = await startMcpTestServer(t, { instructions: () => `Version ${version}.` });
  const service = await catalogService(t, mcp.url, "acme", () => clock);
  const listings = () => mcp.requests.filter((r) => r.rpc === "initialize").length;
  const describe = async () => (await service.toolDefsFor("alice@example.com"))[0]!.description;
  const first = await describe();
  assert.ok(first.endsWith("Version 1."));
  version = 2;
  await service.refresh();
  assert.equal(await describe(), first, "a fresh value is served without listing again");
  assert.equal(listings(), 1);
  clock += 10 * 60_000;
  assert.equal(await describe(), first, "the stale value is served without waiting");
  await settle(async () => listings() === 2);
  await settle(async () => (await describe()).endsWith("Version 2."));
  assert.ok((await describe()).endsWith("Version 2."));
  assert.equal(listings(), 2);
  clock += 10 * 60_000;
  await service.refresh();
  mcp.unavailable = true;
  assert.ok((await describe()).endsWith("Version 2."), "a failed refresh keeps the last-known text");
  await settle(async () => listings() === 3);
  assert.ok((await describe()).endsWith("Version 2."), "a failure is not retried on the next turn");
  assert.equal(listings(), 3);
});

test("a listing that fails after a newer one succeeded does not roll the instructions back", async (t) => {
  let version = 1;
  let clock = 1_000;
  const mcp = await startMcpTestServer(t, { instructions: () => `Version ${version}.` });
  const held: ServerResponse[] = [];
  let holding = false;
  const proxy = createServer((req, res) => {
    if (holding) return void held.push(res);
    const upstream = request(`${mcp.url}${req.url}`, { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    req.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const service = await catalogService(
    t,
    `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/mcp`,
    "acme",
    () => clock,
  );
  const describe = async () => (await service.toolDefsFor("alice@example.com"))[0]!.description;
  assert.ok((await describe()).endsWith("Version 1."));
  clock += 10 * 60_000;
  await service.refresh();
  holding = true;
  assert.ok((await describe()).endsWith("Version 1."), "the stale value is served while the old listing hangs");
  await settle(async () => held.length === 1);
  holding = false;
  version = 2;
  await service.refresh();
  await settle(async () => (await describe()).endsWith("Version 2."));
  for (const res of held) res.destroy();
  await sleep(100);
  assert.ok((await describe()).endsWith("Version 2."), "the late failure leaves the newer text in place");
});

test("a catalog whose listing is slow or empty leaves the description untouched", async (t) => {
  const silent = createServer(() => undefined);
  silent.listen(0, "127.0.0.1");
  await once(silent, "listening");
  t.after(async () => {
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });
  const slow = await catalogService(t, `http://127.0.0.1:${(silent.address() as AddressInfo).port}/mcp`, "slow");
  const started = Date.now();
  assert.deepEqual(await slow.toolDefsFor("alice@example.com"), slow.toolDefs());
  assert.ok(Date.now() - started < 5_000);
  const again = Date.now();
  assert.deepEqual(await slow.toolDefsFor("alice@example.com"), slow.toolDefs());
  assert.ok(Date.now() - again < 500, "a timed-out listing is not awaited again on the next turn");
  const mcp = await startMcpTestServer(t);
  const quiet = await catalogService(t, mcp.url, "quiet");
  assert.deepEqual(await quiet.toolDefsFor("alice@example.com"), quiet.toolDefs());
});

test("a catalog's instructions are cut at a line boundary past the description cap", async (t) => {
  const lines = Array.from({ length: 400 }, (_, i) => `- skill-${i}: ${"x".repeat(40)}`);
  const mcp = await startMcpTestServer(t, { instructions: lines.join("\n") });
  const service = await catalogService(t, mcp.url);
  const [def] = await service.toolDefsFor("alice@example.com");
  assert.ok(def!.description.length <= 8_000);
  assert.ok(def!.description.length > 7_900);
  const body = def!.description.split("\n");
  assert.equal(body.at(-1), "…");
  assert.match(body.at(-2)!, /^- skill-\d+: x{40}$/);
});

test("disabled server's tools disappear and calls fail", async (t) => {
  const mcp = await startMcpTestServer(t);
  const store = createMcpServerStore(createMemoryMap<McpServer>());
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
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool/);
  service.close();
});

function tokenStore() {
  return createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds: createMemoryMap<KeychainCredential>(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("mcp-test-encryption-key"),
  });
}

test("per-user calls resolve only the caller's fresh token while discovery uses catalog auth", async (t) => {
  const mcp = await startMcpTestServer(t, {
    call: (_name, args) => ({ content: [{ type: "text", text: String(args.q) }] }),
  });
  const store = createMcpServerStore(createMemoryMap<McpServer>());
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
  const store = createMcpServerStore(createMemoryMap<McpServer>());
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
  const count = mcp.requests.length;
  await assert.rejects(service.call("crm_query", {}, "internal:alice"), /requires a connected user/);
  assert.equal(mcp.requests.length, count);
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
  const store = createMcpServerStore(createMemoryMap<McpServer>());
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

test("background MCP refresh contains registry failures at startup, on change, and on its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const backing = createMemoryMap<McpServer>();
  const store = createMcpServerStore(backing);
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
  const store = createMcpServerStore(createMemoryMap<McpServer>());
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
