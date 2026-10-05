import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("MCP admin validates and preserves credential scope, without returning secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(createMemoryMap<McpServer>());
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
});

test("production wiring never uses operator fallback tokens for per-user MCP calls", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-wiring-"));
  const previous = process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
  process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = "operator-token";
  const built = buildApp(testConfig({ dataDir: dir, egressServiceHosts: ["accounts.example.com"] }));
  let calls = 0;
  const remote = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.method === "tools/call") calls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: rpc.id,
        result:
          rpc.method === "tools/list"
            ? { tools: [{ name: "identity", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: req.headers.authorization }] },
      }),
    );
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  t.after(async () => {
    built.mcpToolService.close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    if (previous === undefined) delete process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
    else process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await built.mcpServers.put({
    id: "crm",
    name: "CRM",
    url: `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`,
    auth: "none",
    credentialScope: "per-user",
    credentialHost: "accounts.example.com",
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
  await assert.rejects(built.mcpToolService.call("crm_identity", {}, "internal:alice"), /Connect your account/);
  assert.equal(calls, 0);
  await built.connectorTokens.setConnectorToken("accounts.example.com", "internal:alice", {
    accessToken: "alice-only",
  });
  assert.equal(await built.mcpToolService.call("crm_identity", {}, "internal:alice"), "Bearer alice-only");
  assert.equal(calls, 1);
});

test("MCP admin accepts per-user OAuth servers, discovers endpoints, and never shadows built-in connectors", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-oauth-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
  });
  const issuer = createServer((req, res) => {
    if (req.url !== "/.well-known/oauth-authorization-server") return void res.writeHead(404).end();
    const base = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` }));
  });
  server.listen(0, "127.0.0.1");
  issuer.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(issuer, "listening")]);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => issuer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers`;
  const put = (id: string, body: object) =>
    fetch(`${base}/${id}`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ url: "https://tools.example.com/mcp", auth: "oauth-user", ...body }),
    });
  assert.equal((await put("orders", { clientId: "c" })).status, 400);
  assert.equal((await put("github", { clientId: "c", oauthIssuer: `http://127.0.0.1:1` })).status, 400);
  assert.equal(
    (await put("orders", { clientId: "c", oauthIssuer: "x", credentialHost: "api.github.com" })).status,
    400,
  );
  const issuerUrl = `http://127.0.0.1:${(issuer.address() as AddressInfo).port}`;
  const saved = await put("orders", { clientId: " c ", oauthIssuer: issuerUrl, oauthScopes: "a b" });
  assert.equal(saved.status, 200);
  const record = (await store.get("orders"))!;
  assert.equal(record.credentialScope, "per-user");
  assert.equal(record.credentialHost, "tools.example.com");
  assert.equal(record.clientId, "c");
  assert.equal(record.oauthAuthorizeUrl, `${issuerUrl}/authorize`);
  assert.equal(record.oauthTokenUrl, `${issuerUrl}/token`);
  assert.deepEqual(record.oauthScopes, ["a", "b"]);
  assert.equal(record.clientSecret, undefined);
});
