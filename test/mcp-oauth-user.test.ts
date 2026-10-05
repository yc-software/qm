import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpServerStore, type McpServer } from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService, mcpPublicOAuthClients } from "../src/mcp/mcp-tool-service.ts";
import {
  authorizeUrl,
  exchangeCode,
  makeRefresh,
  PROVIDERS,
  setPublicOAuthClients,
  withPublicOAuthClients,
} from "../src/connectors/oauth.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

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
  assert.ok(PROVIDERS.orders?.pkce);
  assert.equal(PROVIDERS.off, undefined);
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

  setPublicOAuthClients([]);
  assert.equal(PROVIDERS.orders, undefined);
  setPublicOAuthClients(mcpPublicOAuthClients([oauthServer({ id: "github", credentialHost: "x.example" })]));
  assert.notEqual(PROVIDERS.github?.pkce, true, "built-in providers are never shadowed");
});

test("oauth-user tools offer a sign-in link until the caller connects, then use only their token", async (t) => {
  const store = createMcpServerStore(createMemoryMap<McpServer>());
  const tokens = new Map<string, string>();
  const auth: string[] = [];
  const service = createMcpToolService({
    servers: store,
    userTokens: { connectorAccessToken: async (_host, principalId) => tokens.get(principalId) ?? null },
    signInUrl: (id) => `https://qm.example/connect/${id}/self-connect`,
    fetchImpl: async (_url, init) => {
      auth.push(init.headers.authorization ?? "");
      const rpc = JSON.parse(init.body) as { id: number; method: string; params: { arguments?: { q?: string } } };
      const result =
        rpc.method === "tools/list"
          ? { tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: `found ${rpc.params.arguments?.q}` }] };
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) };
    },
  });
  t.after(() => service.close());
  await store.put(oauthServer());
  await service.refresh();
  assert.deepEqual(
    service.toolDefs().map((d) => d.name),
    ["orders_sign_in"],
  );
  assert.equal(auth.length, 0, "no unauthenticated discovery");
  assert.match(
    await service.call("orders_sign_in", {}, "internal:alice"),
    /\[Connect Orders\]\(https:\/\/qm\.example\/connect\/orders\/self-connect\)/,
  );

  tokens.set("internal:alice", "alice-token");
  assert.match(await service.call("orders_sign_in", {}, "internal:alice"), /orders_search/);
  assert.deepEqual(
    service.toolDefs().map((d) => d.name),
    ["orders_search"],
  );
  assert.equal(await service.call("orders_search", { q: "tacos" }, "internal:alice"), "found tacos");
  assert.match(await service.call("orders_search", { q: "x" }, "internal:bob"), /Connect Orders/);
  assert.deepEqual(auth, ["Bearer alice-token", "Bearer alice-token"]);
});
