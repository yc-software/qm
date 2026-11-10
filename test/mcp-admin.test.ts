import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { loopbackFetch, startMcpTestServer } from "./support/mcp-test-server.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { discoverOAuth, registerPublicClient } from "../src/mcp/oauth-discovery.ts";
import { errMessage } from "../src/util/errors.ts";
import { testMap } from "./support/test-database.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("MCP admin validates and preserves credential scope, without returning secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(testMap<McpServer>());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers/crm`;
  const put = (body: object, headers = ADMIN) =>
    fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ url: "https://tools.example.com/mcp", validate: false, ...body }),
    });
  assert.equal((await put({ credentialScope: "other" })).status, 400);
  assert.equal((await put({ credentialScope: "per-user" })).status, 400);
  assert.equal(
    (await put({ credentialScope: "per-user", credentialHost: "accounts.example.com", credentialAccountType: "other" }))
      .status,
    400,
  );
  for (const credentialHost of ["", " accounts.example.com", "accounts.example.com/path", "host@evil", 1]) {
    assert.equal((await put({ credentialScope: "per-user", credentialHost })).status, 400);
  }
  assert.equal(
    (
      await put({
        credentialScope: "per-user",
        credentialHost: "accounts.example.com",
        url: "http://tools.example.com/mcp",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await put(
        { credentialScope: "per-user", credentialHost: "accounts.example.com" },
        { ...ADMIN, "x-admin-actor": "nobody@default-org" },
      )
    ).status,
    403,
  );
  assert.equal((await put({})).status, 200);
  assert.equal((await store.get("crm"))?.readOnly, false);
  assert.equal((await put({ readOnly: true })).status, 200);
  assert.equal((await put({})).status, 200);
  assert.equal((await store.get("crm"))?.readOnly, true, "an update that omits readOnly keeps it");
  assert.equal((await put({ enabled: false })).status, 200);
  assert.equal((await put({})).status, 200);
  assert.equal((await store.get("crm"))?.enabled, false, "an update that omits enabled keeps it");
  assert.equal((await put({ enabled: true })).status, 200);
  const saved = await put({
    credentialScope: "per-user",
    credentialHost: "accounts.example.com",
    auth: "bearer",
    bearerToken: "catalog-secret",
    credentialAccountType: "personal",
  });
  assert.equal(saved.status, 200);
  const body = await saved.text();
  assert.doesNotMatch(body, /catalog-secret/);
  assert.equal(JSON.parse(body).server.credentialScope, "per-user");
  assert.equal((await put({ auth: "bearer" })).status, 200);
  assert.equal((await store.get("crm"))?.credentialScope, "per-user");
  assert.equal((await store.get("crm"))?.credentialHost, "accounts.example.com");
  assert.equal((await store.get("crm"))?.credentialAccountType, "personal");
  assert.equal((await store.get("crm"))?.bearerToken, "catalog-secret");
  assert.equal((await put({ credentialScope: "shared" })).status, 200);
  assert.equal((await store.get("crm"))?.credentialScope, "shared");
  assert.equal((await store.get("crm"))?.credentialHost, undefined);
  assert.equal((await store.get("crm"))?.credentialAccountType, undefined);
  assert.equal((await put({ approval: "sometimes" })).status, 400);
  assert.equal((await put({ approval: "all" })).status, 200);
  assert.equal((await store.get("crm"))?.approval, "all");
  assert.equal((await put({})).status, 200);
  assert.equal((await store.get("crm"))?.approval, "all", "an update that omits the policy keeps it");
  assert.equal((await put({ approval: "annotations" })).status, 200);
  assert.equal((await store.get("crm"))?.approval, undefined);
  assert.equal((await put({ attestActor: true })).status, 400);
  assert.equal(
    (await put({ catalog: true, attestActor: true, auth: "none" })).status,
    400,
    "an unauthenticated upstream cannot trust the actor",
  );
  assert.equal(
    (
      await put({
        catalog: true,
        attestActor: true,
        auth: "bearer",
        bearerToken: "t",
        credentialScope: "per-user",
        credentialHost: "accounts.example.com",
      })
    ).status,
    400,
    "a per-person token could otherwise assert someone else",
  );
  assert.equal(
    (await put({ catalog: true, attestActor: true, auth: "bearer", bearerToken: "t", credentialScope: "shared" }))
      .status,
    200,
  );
  assert.deepEqual([(await store.get("crm"))?.catalog, (await store.get("crm"))?.attestActor], [true, true]);
  const bearer = { auth: "bearer", bearerToken: "t" };
  assert.equal((await put({ ...bearer, attestAudience: "everywhere" })).status, 400);
  assert.equal((await put({ ...bearer, attestAudience: "any" })).status, 200);
  assert.equal((await store.get("crm"))?.attestAudience, "any");
  assert.equal((await put(bearer)).status, 200);
  assert.equal((await store.get("crm"))?.attestAudience, "any", "an update that omits the audience keeps it");
  assert.equal((await put({ ...bearer, attestAudience: "personal" })).status, 200);
  assert.equal((await store.get("crm"))?.attestAudience, undefined);
  assert.equal((await put({ ...bearer, attestActor: false, attestAudience: "any" })).status, 400);
  assert.equal((await put({ ...bearer, attestAudience: "any" })).status, 200);
  assert.equal((await put({ ...bearer, attestActor: false })).status, 200);
  assert.deepEqual(
    [(await store.get("crm"))?.attestActor, (await store.get("crm"))?.attestAudience],
    [undefined, undefined],
    "turning attestation off drops its audience",
  );
});

test("production wiring never uses operator fallback tokens for per-user MCP calls and refuses private MCP addresses", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-wiring-"));
  const previous = process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
  process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = "operator-token";
  const built = buildApp(testConfig({ dataDir: dir, egressServiceHosts: ["accounts.example.com"] }));
  const remote = await startMcpTestServer(t, {
    tools: [{ name: "identity", inputSchema: { type: "object" } }],
    call: (_name, _args, authorization) => ({ content: [{ type: "text", text: authorization ?? "" }] }),
  });
  t.after(async () => {
    built.mcpToolService.close();
    if (previous === undefined) delete process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
    else process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await built.mcpServers.put({
    id: "crm",
    name: "CRM",
    url: `${remote.url}/mcp`,
    auth: "oauth-user",
    credentialScope: "per-user",
    credentialHost: "accounts.example.com",
    tools: [{ name: "identity", description: "", inputSchema: { type: "object" } }],
    readOnly: true,
    enabled: true,
    updatedAt: Date.now(),
    updatedBy: "internal:admin",
  });
  await built.mcpToolService.refresh();
  assert.equal(
    await built.connectorTokens.connectorAccessToken("accounts.example.com", "internal:alice"),
    "operator-token",
  );
  assert.match(await built.mcpToolService.call("crm_identity", {}, "internal:alice"), /Sign in to CRM/);
  assert.equal(remote.requests.length, 0);
  await built.connectorTokens.setConnectorToken("accounts.example.com", "internal:alice", {
    accessToken: "alice-only",
  });
  await assert.rejects(built.mcpToolService.call("crm_identity", {}, "internal:alice"), (e: unknown) =>
    /private network address/.test(errMessage(e)),
  );
  assert.equal(remote.requests.length, 0, "production wiring refuses a loopback MCP server");
});

test("MCP admin accepts per-user OAuth servers, discovers endpoints only from public addresses, and never shadows built-in connectors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-oauth-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(testMap<McpServer>());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers`;
  const put = (id: string, body: object) =>
    fetch(`${base}/${id}`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ url: "https://127.0.0.1/mcp", auth: "oauth-user", ...body }),
    });

  const issuer = "https://mcp.example.com";
  const metadata: Record<string, object> = {
    [`${issuer}/.well-known/oauth-authorization-server/id`]: {
      authorization_endpoint: `${issuer}/id/authorize`,
      token_endpoint: `${issuer}/id/token`,
    },
    [`${issuer}/.well-known/oauth-protected-resource/mcp`]: {
      resource: `${issuer}/mcp`,
      authorization_servers: [`${issuer}/id`],
      scopes_supported: ["mcp:write"],
    },
  };
  const metadataFetch = async (input: string | URL) => {
    const meta = metadata[String(input)];
    return meta ? Response.json(meta) : new Response(null, { status: 404 });
  };
  assert.deepEqual(await discoverOAuth(new URL(`${issuer}/mcp`), metadataFetch), {
    authorize: `${issuer}/id/authorize`,
    token: `${issuer}/id/token`,
    scopes: ["mcp:write"],
    errors: [],
  });
  assert.match((await discoverOAuth(new URL(`${issuer}/elsewhere`), metadataFetch)).errors.join("; "), /HTTP 404/);
  const registrable = {
    ...metadata[`${issuer}/.well-known/oauth-authorization-server/id`],
    issuer: `${issuer}/id`,
    response_types_supported: ["code"],
    registration_endpoint: `${issuer}/id/register`,
  };
  const withRegistration = async (input: string | URL) =>
    String(input).endsWith("/oauth-authorization-server/id") ? Response.json(registrable) : metadataFetch(input);
  const found = await discoverOAuth(new URL(`${issuer}/mcp`), withRegistration);
  assert.equal(found.registrable?.registration_endpoint, `${issuer}/id/register`);
  const registrations: Array<{ url: string; body: Record<string, unknown> }> = [];
  const registerFetch = async (input: string | URL, init?: RequestInit) => {
    registrations.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ client_id: "dcr-client", redirect_uris: ["https://qm.test/cb"] }, { status: 201 });
  };
  assert.equal(await registerPublicClient(found.registrable!, ["https://qm.test/cb"], registerFetch), "dcr-client");
  assert.deepEqual(registrations, [
    {
      url: `${issuer}/id/register`,
      body: {
        client_name: "QM",
        redirect_uris: ["https://qm.test/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    },
  ]);
  await assert.rejects(
    registerPublicClient(found.registrable!, ["https://qm.test/cb"], async () =>
      Response.json({ error: "access_denied", error_description: "registration is closed" }, { status: 403 }),
    ),
    /registration is closed/,
  );

  const plainHttp = await put("orders", { clientId: "c", url: "http://127.0.0.1/mcp" });
  assert.equal(plainHttp.status, 400);
  assert.equal(((await plainHttp.json()) as { message: string }).message, "per-user credentials require HTTPS");
  const privateIssuer = await put("orders", { clientId: "c" });
  assert.equal(privateIssuer.status, 400);
  assert.match(
    ((await privateIssuer.json()) as { message: string }).message,
    /discovery: .*127\.0\.0\.1 is a private network address/,
  );
  assert.ok(!(await store.get("orders")));
  assert.equal((await put("github", { clientId: "c" })).status, 400, "built-in connector ids are reserved");
  assert.equal((await put("orders", { clientId: "c", credentialHost: "github.com" })).status, 400);
  assert.equal((await put("orders", { clientId: "c", oauthTokenUrl: "http://id.example.com/token" })).status, 400);

  assert.equal(
    (
      await put("manual", {
        clientId: "c",
        url: "https://tools.example.com/mcp",
        oauthAuthorizeUrl: "https://id.example.com/authorize",
        oauthTokenUrl: "https://id.example.com/token",
        oauthScopes: "a b",
      })
    ).status,
    200,
    "explicit endpoints skip discovery",
  );
  const record = (await store.get("manual"))!;
  assert.equal(record.credentialScope, "per-user");
  assert.equal(record.credentialHost, "tools.example.com");
  assert.equal(record.clientId, "c");
  assert.equal(record.clientSecret, undefined);
  assert.deepEqual(record.oauthScopes, ["a", "b"]);
});

test("MCP admin save stores the server's own description from the probe", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-about-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(testMap<McpServer>());
  const service = createMcpToolService({ fetch: loopbackFetch, servers: store, refreshIntervalMs: 3600_000 });
  const remote = await startMcpTestServer(t, { instructions: "Search and update CRM records.\nAlways query first." });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
    mcpToolService: service,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers/crm`, {
    method: "PUT",
    headers: ADMIN,
    body: JSON.stringify({ url: `${remote.url}/mcp` }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { tools: string[] }).tools, ["query", "update"]);
  assert.equal((await store.get("crm"))!.about, "Search and update CRM records.\nAlways query first.");
});

test("MCP admin edit that omits fields keeps the stored auth, name, credentials and discovered tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-merge-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(testMap<McpServer>());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers`;
  const put = (id: string, body: object) =>
    fetch(`${base}/${id}`, { method: "PUT", headers: ADMIN, body: JSON.stringify({ validate: false, ...body }) });
  const url = "https://tools.example.com/mcp";
  assert.equal((await put("crm", { url, name: "CRM", auth: "bearer", bearerToken: "secret" })).status, 200);
  assert.equal((await put("crm", { url, readOnly: true })).status, 200);
  const crm = await store.get("crm");
  assert.equal(crm?.auth, "bearer");
  assert.equal(crm?.bearerToken, "secret");
  assert.equal(crm?.name, "CRM");
  assert.equal((await put("crm", { readOnly: false })).status, 200);
  assert.equal((await store.get("crm"))?.url, url);
  assert.equal((await put("cc", { url, auth: "client-credentials", clientId: "id", clientSecret: "cs" })).status, 200);
  assert.equal((await put("cc", { url, enabled: false })).status, 200);
  assert.equal((await store.get("cc"))?.clientSecret, "cs");
  await store.put({
    id: "orders",
    name: "Orders",
    url,
    auth: "oauth-user",
    credentialScope: "per-user",
    credentialHost: "tools.example.com",
    clientId: "c",
    oauthAuthorizeUrl: "https://id.example.com/authorize",
    oauthTokenUrl: "https://id.example.com/token",
    oauthScopes: ["a"],
    tools: [{ name: "lookup", description: "", inputSchema: { type: "object" } }],
    about: "Orders",
    readOnly: false,
    enabled: true,
    updatedAt: 1,
    updatedBy: "admin",
  });
  assert.equal((await put("orders", { url, readOnly: true })).status, 200);
  const orders = await store.get("orders");
  assert.equal(orders?.auth, "oauth-user");
  assert.equal(orders?.clientId, "c");
  assert.deepEqual(
    orders?.tools?.map((tool) => tool.name),
    ["lookup"],
  );
  assert.equal(orders?.about, "Orders");
  assert.equal((await put("orders", { url: "https://other.example.com/mcp" })).status, 200);
  assert.equal((await store.get("orders"))?.tools, undefined);
});
