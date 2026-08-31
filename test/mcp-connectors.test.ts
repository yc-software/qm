import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  createPinnedMcpLookup,
  createMcpClient,
  isPublicMcpAddress,
  mcpRemoteAddressMatchesPins,
  mcpResultText,
  validateMcpHttpsUrl,
  type McpFetch,
} from "../src/mcp/mcp-client.ts";
import {
  createMcpServerStore,
  isValidMcpServerId,
  parseMcpAllowedTools,
  type McpServer,
  type StoredMcpServer,
} from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

function jsonResponse(
  body: unknown,
  status = 200,
  contentType = "application/json",
  extra: { redirected?: boolean; url?: string } = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    ...extra,
  };
}

const queryTool = (overrides: Record<string, unknown> = {}) => ({
  name: "query",
  description: "Run a query",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations: { readOnlyHint: true, destructiveHint: false },
  ...overrides,
});

const updateTool = {
  name: "update",
  description: "Write a record",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

function fakeServerFetch(state?: { tools?: Array<Record<string, unknown>>; bearer?: string; callError?: string }) {
  const calls: Array<{ url: string; method: string; rpc?: string; name?: string; redirect: string }> = [];
  let tools = state?.tools ?? [queryTool(), updateTool];
  const fetch: McpFetch = async (url, init) => {
    const request = JSON.parse(init.body) as { id: number; method: string; params: { name?: string } };
    calls.push({ url, method: init.method, rpc: request.method, name: request.params.name, redirect: init.redirect });
    if (state?.bearer && init.headers.authorization !== `Bearer ${state.bearer}`) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    let result: Record<string, unknown>;
    if (request.method === "tools/list") result = { tools };
    else if (state?.callError) result = { isError: true, content: [{ type: "text", text: state.callError }] };
    else result = { content: [{ type: "text", text: `ran ${request.params.name}` }] };
    return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
  };
  return {
    fetch,
    calls,
    setTools(next: Array<Record<string, unknown>>) {
      tools = next;
    },
  };
}

const key = deriveConnectorKey("mcp-test-secret", "mcp-server-secrets");

function allowed(readOnly = true) {
  return [
    {
      name: "query",
      label: "Search CRM",
      status: "Searching the CRM",
      readOnly,
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ];
}

function server(partial: Partial<McpServer> = {}): McpServer {
  return {
    id: "crm",
    name: "CRM",
    url: "https://mcp.example.com/mcp",
    auth: "none",
    scopes: [],
    allowedTools: allowed(),
    readOnly: true,
    enabled: true,
    credentialState: "none",
    updatedAt: 1,
    updatedBy: "internal:admin",
    ...partial,
  };
}

function storeWithBacking() {
  const backing = createMemoryMap<StoredMcpServer>();
  return { backing, store: createMcpServerStore(backing, key) };
}

test("mcp client lists annotated tools and calls one over JSON and SSE", async () => {
  for (const sse of [false, true]) {
    const remote = fakeServerFetch();
    const fetch: McpFetch = async (url, init) => {
      const response = await remote.fetch(url, init);
      if (!sse) return response;
      const envelope = await response.text();
      return jsonResponse(`event: message\ndata: ${envelope}\n\n`, 200, "text/event-stream");
    };
    const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.readOnlyHint, tool.destructiveHint]),
      [
        ["query", true, false],
        ["update", false, true],
      ],
    );
    assert.equal(mcpResultText(await client.callTool("query", { q: "hi" })), "ran query");
    assert.ok(remote.calls.every((call) => call.redirect === "manual"));
  }
  const unsafe = fakeServerFetch({
    tools: [queryTool({ inputSchema: JSON.parse('{"type":"object","__proto__":{"polluted":true}}') })],
  });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: unsafe.fetch,
  });
  await assert.rejects(() => client.listTools(), /unsafe input schema/);
});

test("MCP SDK root schema dialects normalize without widening nested schemas", async () => {
  const remote = fakeServerFetch({
    tools: [
      queryTool({
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
      }),
    ],
  });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: remote.fetch,
  });
  assert.deepEqual((await client.listTools())[0]?.inputSchema, {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  });
  for (const inputSchema of [
    { $schema: "https://attacker.example/schema", type: "object" },
    { type: "object", properties: { q: { $schema: "http://json-schema.org/draft-07/schema#", type: "string" } } },
  ]) {
    const rejected = fakeServerFetch({ tools: [queryTool({ inputSchema })] });
    const rejectedClient = createMcpClient({
      url: "https://mcp.example.com/mcp",
      auth: { mode: "none" },
      fetchImpl: rejected.fetch,
    });
    await assert.rejects(() => rejectedClient.listTools(), /unsafe input schema/);
  }
});

test("pinned DNS lookup returns the callback shape requested by Node", async () => {
  const pinned = createPinnedMcpLookup("8.8.8.8");
  await new Promise<void>((resolve, reject) => {
    pinned("mcp.example.com", { all: true }, (error, addresses, family) => {
      if (error) return reject(error);
      assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
      assert.equal(family, undefined);
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    pinned("mcp.example.com", {}, (error, address, family) => {
      if (error) return reject(error);
      assert.equal(address, "8.8.8.8");
      assert.equal(family, 4);
      resolve();
    });
  });
});

test("JSON and SSE transports reject malformed JSON-RPC response envelopes", async () => {
  const malformed = [
    { jsonrpc: "1.0", id: 1, result: { tools: [] } },
    { id: 1, result: { tools: [] } },
    { jsonrpc: "2.0", id: 1, result: { tools: [] }, error: null },
    { jsonrpc: "2.0", id: 1, error: null },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", id: 1, error: { message: "bad" } },
    { jsonrpc: "2.0", id: 1, result: { tools: [] }, extra: true },
    { jsonrpc: "2.0", id: 1, error: { code: -1, message: "bad", extra: true } },
  ];
  for (const contentType of ["application/json", "text/event-stream"]) {
    for (const envelope of malformed) {
      const client = createMcpClient({
        url: "https://mcp.example.com/mcp",
        auth: { mode: "none" },
        fetchImpl: async (_url, init) => {
          const request = JSON.parse(init.body) as { id: number };
          const body = JSON.stringify({ ...envelope, id: request.id });
          return jsonResponse(
            contentType === "text/event-stream" ? `event: message\ndata: ${body}\n\n` : body,
            200,
            contentType,
          );
        },
      });
      await assert.rejects(() => client.listTools(), /invalid response envelope/);
    }
  }
});

test("client credentials use the explicit token contract and cache the token", async () => {
  const forms: URLSearchParams[] = [];
  let tokenCalls = 0;
  const fetch: McpFetch = async (url, init) => {
    if (url === "https://auth.example.com/oauth/token") {
      tokenCalls += 1;
      forms.push(new URLSearchParams(init.body));
      return jsonResponse({ access_token: "minted", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(init.headers.authorization, "Bearer minted");
    const request = JSON.parse(init.body) as { id: number; method: string; params: { name?: string } };
    return jsonResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: request.method === "tools/list" ? { tools: [queryTool()] } : { content: [{ type: "text", text: "ok" }] },
    });
  };
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: {
      mode: "client-credentials",
      clientId: "qm",
      clientSecret: "secret",
      tokenUrl: "https://auth.example.com/oauth/token",
      audience: "https://mcp.example.com/mcp",
      tokenAuthMethod: "client_secret_post",
      tokenAudienceParameter: "audience",
      scopes: ["records:read", "profile"],
    },
    fetchImpl: fetch,
  });
  await Promise.all([client.listTools(), client.listTools()]);
  await client.callTool("query", {});
  assert.equal(tokenCalls, 1);
  assert.equal(forms[0]!.get("grant_type"), "client_credentials");
  assert.equal(forms[0]!.get("client_id"), "qm");
  assert.equal(forms[0]!.get("client_secret"), "secret");
  assert.equal(forms[0]!.get("audience"), "https://mcp.example.com/mcp");
  assert.equal(forms[0]!.get("scope"), "records:read profile");
  assert.throws(() =>
    createMcpClient({
      url: "https://mcp.example.com/mcp",
      auth: {
        mode: "client-credentials",
        clientId: "qm",
        clientSecret: "secret",
        tokenUrl: "https://auth.example.com/oauth/token",
        audience: "https://mcp.example.com/mcp",
        tokenAuthMethod: "client_secret_post",
        tokenAudienceParameter: "audience",
        scopes: ["records:read", "records:read"],
      },
      fetchImpl: fetch,
    }),
  );

  let basicAuthorization = "";
  const basic = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: {
      mode: "client-credentials",
      clientId: "qm client!~'()",
      clientSecret: "sec ret!~'()*",
      tokenUrl: "https://auth.example.com/oauth/token",
      audience: "https://mcp.example.com/mcp",
      tokenAuthMethod: "client_secret_basic",
      tokenAudienceParameter: "resource",
      scopes: [],
    },
    fetchImpl: async (url, init) => {
      if (url.includes("/oauth/token")) {
        basicAuthorization = init.headers.authorization ?? "";
        const form = new URLSearchParams(init.body);
        assert.equal(form.get("resource"), "https://mcp.example.com/mcp");
        assert.equal(form.has("client_secret"), false);
        return jsonResponse({ access_token: "basic-minted", token_type: "bearer", expires_in: 60 });
      }
      const request = JSON.parse(init.body) as { id: number };
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    },
  });
  await basic.listTools();
  assert.equal(
    basicAuthorization,
    `Basic ${Buffer.from("qm+client%21%7E%27%28%29:sec+ret%21%7E%27%28%29*").toString("base64")}`,
  );

  const missingTokenType = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: {
      mode: "client-credentials",
      clientId: "qm",
      clientSecret: "secret",
      tokenUrl: "https://auth.example.com/oauth/token",
      audience: "https://mcp.example.com/mcp",
      tokenAuthMethod: "client_secret_basic",
      tokenAudienceParameter: "resource",
      scopes: [],
    },
    fetchImpl: async () => jsonResponse({ access_token: "minted", expires_in: 60 }),
  });
  await assert.rejects(() => missingTokenType.listTools(), /Bearer access_token/);
});

test("credential material reflected by token or MCP responses is rejected before schema exposure", async () => {
  const bearerClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "bearer", token: "credential-secret" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id: number };
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [queryTool({ inputSchema: { type: "object", default: "credential-secret" } })] },
      });
    },
  });
  await assert.rejects(() => bearerClient.listTools(), /credential material/);

  const escapedBearerClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "bearer", token: "credential-secret" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id: number };
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [queryTool({ inputSchema: { type: "object", default: "credential-secret" } })] },
      }).replace("credential-secret", "credential-s\\u0065cret");
      return jsonResponse(body);
    },
  });
  await assert.rejects(() => escapedBearerClient.listTools(), /credential material/);

  const escapedBearerKeyClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "bearer", token: "credential-secret" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id: number };
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [
            queryTool({ inputSchema: { type: "object", properties: { "credential-secret": { type: "string" } } } }),
          ],
        },
      }).replace("credential-secret", "credential-s\\u0065cret");
      return jsonResponse(body);
    },
  });
  await assert.rejects(() => escapedBearerKeyClient.listTools(), /credential material/);

  const oauthClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: {
      mode: "client-credentials",
      clientId: "qm",
      clientSecret: "client-secret",
      tokenUrl: "https://auth.example.com/oauth/token",
      audience: "https://mcp.example.com/mcp",
      tokenAuthMethod: "client_secret_basic",
      tokenAudienceParameter: "resource",
      scopes: ["records:read"],
    },
    fetchImpl: async (url, init) => {
      if (url.includes("/oauth/token")) {
        return jsonResponse({ access_token: "minted-secret", token_type: "Bearer", expires_in: 3600 });
      }
      const request = JSON.parse(init.body) as { id: number };
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [queryTool({ inputSchema: { type: "object", default: "minted-secret" } })] },
      });
    },
  });
  await assert.rejects(() => oauthClient.listTools(), /credential material/);

  const reflectedClientSecret = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: {
      mode: "client-credentials",
      clientId: "qm",
      clientSecret: "client-secret",
      tokenUrl: "https://auth.example.com/oauth/token",
      audience: "https://mcp.example.com/mcp",
      tokenAuthMethod: "client_secret_post",
      tokenAudienceParameter: "audience",
      scopes: [],
    },
    fetchImpl: async () => jsonResponse({ access_token: "minted", token_type: "Bearer", reflected: "client-secret" }),
  });
  await assert.rejects(() => reflectedClientSecret.listTools(), /credential material/);
});

test("MCP URL, DNS, and redirect validation fail before a usable response", async () => {
  for (const value of [
    "http://mcp.example.com/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://mcp.example.com/mcp?token=x",
  ]) {
    assert.throws(() => validateMcpHttpsUrl(value));
  }
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "2001::1",
    "2001:2::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "2002:7f00:1::",
    "2620:4f:8000::1",
    "3fff::1",
    "fd00::1",
    "ff02::1",
  ]) {
    assert.equal(isPublicMcpAddress(address), false);
  }
  assert.equal(isPublicMcpAddress("8.8.8.8"), true);
  assert.equal(isPublicMcpAddress("2001:4860:4860::8888"), true);
  assert.equal(mcpRemoteAddressMatchesPins("8.8.8.8", ["8.8.8.8", "1.1.1.1"]), true);
  assert.equal(mcpRemoteAddressMatchesPins("::ffff:8.8.8.8", ["8.8.8.8"]), true);
  assert.equal(mcpRemoteAddressMatchesPins("2001:4860:4860:0000:0000:0000:0000:8888", ["2001:4860:4860::8888"]), true);
  assert.equal(mcpRemoteAddressMatchesPins("1.1.1.1", ["8.8.8.8"]), false);
  assert.equal(mcpRemoteAddressMatchesPins("127.0.0.1", ["127.0.0.1"]), false);
  let fetchCalls = 0;
  const privateClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    resolveHost: async () => ["10.0.0.5"],
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });
  await assert.rejects(() => privateClient.listTools(), /public addresses/);
  assert.equal(fetchCalls, 0);
  let pinnedAddress: string | undefined;
  let pinnedAddresses: readonly string[] | undefined;
  const pinnedClient = createMcpClient({
    url: "https://mcp.example.com:443/mcp",
    auth: { mode: "none" },
    resolveHost: async () => ["8.8.8.8"],
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://mcp.example.com/mcp");
      pinnedAddress = init.resolvedAddress;
      pinnedAddresses = init.resolvedAddresses;
      const request = JSON.parse(init.body) as { id: number };
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }, 200, "application/json", {
        url,
      });
    },
  });
  assert.deepEqual(await pinnedClient.listTools(), []);
  assert.equal(pinnedAddress, "8.8.8.8");
  assert.deepEqual(pinnedAddresses, ["8.8.8.8"]);
  for (const response of [
    jsonResponse({}, 302),
    jsonResponse({}, 200, "application/json", { redirected: true, url: "https://evil.example/mcp" }),
  ]) {
    const client = createMcpClient({
      url: "https://mcp.example.com/mcp",
      auth: { mode: "none" },
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, "manual");
        return response;
      },
    });
    await assert.rejects(() => client.listTools(), /redirects are not allowed/);
  }
  for (const contentType of ["application/json", "text/event-stream"]) {
    const client = createMcpClient({
      url: "https://mcp.example.com/mcp",
      auth: { mode: "none" },
      fetchImpl: async () => {
        const envelope = JSON.stringify({ jsonrpc: "2.0", id: 999, result: { tools: [] } });
        return jsonResponse(
          contentType === "text/event-stream" ? `event: message\ndata: ${envelope}\n\n` : envelope,
          200,
          contentType,
        );
      },
    });
    await assert.rejects(() => client.listTools(), /invalid response envelope/);
  }
});

test("tools/list and tools/call result shapes fail closed", async () => {
  for (const result of [
    null,
    {},
    { tools: "bad" },
    { tools: [], nextCursor: "more" },
    { tools: [], nextCursor: null },
  ]) {
    const client = createMcpClient({
      url: "https://mcp.example.com/mcp",
      auth: { mode: "none" },
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body) as { id: number };
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
      },
    });
    await assert.rejects(() => client.listTools(), /invalid|incomplete/);
  }
  for (const result of [
    null,
    "text",
    { isError: "yes" },
    { content: "bad" },
    { content: [{}] },
    { content: [{ type: "text" }] },
    { content: [{ type: "unknown" }] },
    { content: [{ type: "image", data: "not base64", mimeType: "image/png" }] },
    { content: [{ type: "resource", resource: { uri: "urn:test", blob: "not base64" } }] },
    { content: [{ type: "text", text: "bad", annotations: { priority: 2 } }] },
    { content: [{ type: "text", text: "bad", annotations: { lastModified: "August 29, 2026" } }] },
    { structuredContent: null },
    { structuredContent: [] },
    { structuredContent: "bad" },
  ]) {
    const client = createMcpClient({
      url: "https://mcp.example.com/mcp",
      auth: { mode: "none" },
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body) as { id: number };
        return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
      },
    });
    await assert.rejects(() => client.callTool("query", {}), /invalid result/);
  }
  const valid = {
    content: [
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "urn:test", text: "resource" } },
      { type: "resource_link", uri: "https://example.com/item", name: "Item" },
    ],
    structuredContent: { ok: true },
  };
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id: number };
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: valid });
    },
  });
  assert.deepEqual(await client.callTool("query", {}), valid);
});

test("one bounded deadline covers DNS and response body consumption", async () => {
  const dnsClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    resolveHost: async () => new Promise<string[]>(() => {}),
    fetchImpl: async () => jsonResponse({}),
    requestTimeoutMs: 10,
  });
  await assert.rejects(() => dnsClient.listTools(), /timed out/);

  const bodyClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => new Promise<string>(() => {}),
      headers: { get: () => "application/json" },
    }),
    requestTimeoutMs: 10,
  });
  await assert.rejects(() => bodyClient.listTools(), /timed out/);
});

test("server credentials are encrypted at rest and decrypt only through the store", async () => {
  for (const configured of [
    server({ auth: "bearer", bearerToken: "bearer-secret", credentialState: "ready" }),
    server({
      auth: "client-credentials",
      clientId: "qm",
      clientSecret: "client-secret",
      tokenUrl: "https://auth.example.com/oauth/token",
      audience: "https://mcp.example.com/mcp",
      tokenAuthMethod: "client_secret_basic",
      tokenAudienceParameter: "resource",
      scopes: ["records:read"],
      credentialState: "ready",
    }),
  ]) {
    const { backing, store } = storeWithBacking();
    await store.put(configured);
    const raw = await backing.get("crm");
    assert.ok(raw?.credentialEnc?.startsWith("v2:"));
    assert.doesNotMatch(JSON.stringify(raw), /bearer-secret|client-secret/);
    assert.equal(Object.hasOwn(raw!, "bearerToken"), false);
    assert.equal(Object.hasOwn(raw!, "clientSecret"), false);
    const decoded = await store.get("crm");
    assert.equal(decoded?.credentialState, "ready");
    assert.equal(decoded?.bearerToken ?? decoded?.clientSecret, configured.bearerToken ?? configured.clientSecret);
  }
  const { backing, store } = storeWithBacking();
  await store.put(server({ clientSecret: "irrelevant-secret" }));
  assert.equal((await backing.get("crm"))?.credentialEnc, undefined);
});

test("legacy plaintext credentials are purged, disabled, and require explicit re-entry", async () => {
  for (const legacy of [
    { ...server({ auth: "bearer" }), bearerToken: "old-bearer" },
    {
      ...server({ auth: "client-credentials" }),
      clientId: "qm",
      clientSecret: "old-client-secret",
      tokenUrl: "https://auth.example.com/oauth/token",
      audience: "https://mcp.example.com/mcp",
      tokenAuthMethod: "client_secret_basic",
      tokenAudienceParameter: "resource",
    },
  ]) {
    const { backing, store } = storeWithBacking();
    await backing.put("crm", legacy as StoredMcpServer);
    const migrated = await store.get("crm");
    assert.equal(migrated?.enabled, false);
    assert.equal(migrated?.credentialState, "reentry-required");
    assert.equal(migrated?.bearerToken, undefined);
    assert.equal(migrated?.clientSecret, undefined);
    const raw = await backing.get("crm");
    assert.doesNotMatch(JSON.stringify(raw), /old-bearer|old-client-secret/);
    assert.equal(Object.hasOwn(raw!, "bearerToken"), false);
    assert.equal(Object.hasOwn(raw!, "clientSecret"), false);
    await assert.rejects(() => store.put({ ...migrated!, enabled: true }), /requires credential re-entry/);
  }
});

test("ciphertext decrypt failures preserve recoverable storage and stay scoped to one server", async () => {
  const backing = createMemoryMap<StoredMcpServer>();
  const correct = createMcpServerStore(backing, key);
  await correct.put(server({ auth: "bearer", bearerToken: "crm-secret", credentialState: "ready" }));
  await correct.put(server({ id: "sales", auth: "bearer", bearerToken: "sales-secret", credentialState: "ready" }));
  const crmRaw = await backing.get("crm");
  const salesRaw = await backing.get("sales");
  const wrong = createMcpServerStore(backing, deriveConnectorKey("wrong-key", "mcp-server-secrets"));
  const unavailable = await wrong.get("crm");
  assert.equal(unavailable?.enabled, false);
  assert.equal(unavailable?.credentialState, "reentry-required");
  assert.deepEqual(await backing.get("crm"), crmRaw);
  assert.equal((await correct.get("crm"))?.bearerToken, "crm-secret");
  assert.equal(
    await wrong.putIfCurrent(
      {
        ...unavailable!,
        bearerToken: "replacement-secret",
        enabled: true,
        credentialState: "ready",
        updatedAt: 2,
      },
      unavailable!.recordVersion!,
    ),
    true,
  );
  assert.equal((await wrong.get("crm"))?.bearerToken, "replacement-secret");

  await correct.put(server({ auth: "bearer", bearerToken: "bound-secret", credentialState: "ready", updatedAt: 3 }));
  const destinationBound = await backing.get("crm");
  await backing.put("crm", { ...destinationBound!, url: "https://other.example.com/mcp" });
  assert.equal((await correct.get("crm"))?.credentialState, "reentry-required");
  assert.equal((await backing.get("crm"))?.credentialEnc, destinationBound?.credentialEnc);

  await backing.put("crm", { ...crmRaw!, credentialEnc: salesRaw!.credentialEnc });
  await backing.put("sales", { ...salesRaw!, credentialEnc: crmRaw!.credentialEnc });
  assert.equal((await correct.get("crm"))?.credentialState, "reentry-required");
  assert.equal((await correct.get("sales"))?.credentialState, "reentry-required");
  assert.equal((await backing.get("crm"))?.credentialEnc, salesRaw!.credentialEnc);
  assert.equal((await backing.get("sales"))?.credentialEnc, crmRaw!.credentialEnc);
});

test("atomic plaintext migration cannot clobber concurrent credential re-entry or resurrect deletion", async () => {
  for (const action of ["replace", "delete"] as const) {
    const backing = createMemoryMap<StoredMcpServer>();
    const originalUpdate = backing.update!.bind(backing);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    backing.update = async (id, fn) => {
      entered();
      await waiting;
      return originalUpdate(id, fn);
    };
    const store = createMcpServerStore(backing, key);
    await backing.put("crm", { ...server({ auth: "bearer" }), bearerToken: "legacy-secret" });
    const read = store.get("crm");
    await started;
    if (action === "replace") {
      await store.put(server({ auth: "bearer", bearerToken: "fresh-secret", credentialState: "ready", updatedAt: 2 }));
    } else {
      await store.delete("crm");
    }
    release();
    const decoded = await read;
    if (action === "replace") {
      assert.equal(decoded?.bearerToken, "fresh-secret");
      assert.equal(decoded?.updatedAt, 2);
      assert.doesNotMatch(JSON.stringify(await backing.get("crm")), /legacy-secret|fresh-secret/);
    } else {
      assert.equal(decoded, null);
      assert.equal(await backing.get("crm"), null);
    }
  }
});

test("allowlist parsing rejects ambiguous or duplicate presentation contracts", () => {
  assert.deepEqual(parseMcpAllowedTools(allowed()), allowed());
  for (const invalid of [
    [],
    [{ name: "query", label: "Search CRM", status: "Searching", readOnly: true, extra: true }],
    [...allowed(), { name: "query", label: "Second label", status: "Searching again", readOnly: true }],
    [...allowed(), { name: "other", label: "Search CRM", status: "Searching again", readOnly: true }],
    [{ ...allowed()[0], inputSchema: { type: "string" } }],
    [
      {
        ...allowed()[0],
        inputSchema: { type: "object", properties: { q: { type: "string", pattern: "(a+)+$" } } },
      },
    ],
    ...["__proto__", "prototype", "constructor"].map((key) => [
      {
        ...allowed()[0],
        inputSchema: { type: "object", properties: JSON.parse(`{"${key}":{"type":"string"}}`) },
      },
    ]),
    ...["exclusiveMinimum", "exclusiveMaximum", "uniqueItems", "oneOf", "allOf", "anyOf"].map((key) => [
      { ...allowed()[0], inputSchema: { type: "object", [key]: key.endsWith("Of") ? [] : true } },
    ]),
  ]) {
    assert.throws(() => parseMcpAllowedTools(invalid));
  }
});

test("tool namespace collisions fail the entire server closed", async () => {
  const tools = [queryTool({ name: "read.id" }), queryTool({ name: "read:id" })];
  const contracts = tools.map((tool, index) => ({
    name: tool.name,
    label: `Read record ${index + 1}`,
    status: `Reading record ${index + 1}`,
    readOnly: true,
    inputSchema: tool.inputSchema,
  }));
  const { store } = storeWithBacking();
  const audit = createAuditLog();
  const remote = fakeServerFetch({ tools });
  const service = createMcpToolService({
    servers: store,
    fetchImpl: remote.fetch,
    audit,
    refreshIntervalMs: 3_600_000,
  });
  await store.put(server({ allowedTools: contracts }));
  await service.refresh();
  assert.deepEqual(service.toolDefs(), []);
  assert.ok((await audit.events()).some((event) => event.status?.includes("collide")));
  service.close();
});

test("reserved approval-exempt MCP names fail the server closed", async () => {
  const remoteTool = queryTool({ name: "silently" });
  const { store } = storeWithBacking();
  const remote = fakeServerFetch({ tools: [remoteTool] });
  const service = createMcpToolService({ servers: store, fetchImpl: remote.fetch, refreshIntervalMs: 3_600_000 });
  await store.put(
    server({
      id: "finish",
      allowedTools: [
        {
          name: "silently",
          label: "Search safely",
          status: "Searching safely",
          readOnly: true,
          inputSchema: remoteTool.inputSchema,
        },
      ],
    }),
  );
  await service.refresh();
  assert.deepEqual(service.toolDefs(), []);
  service.close();
});

test("omitted destructive annotations and oversized discovery lists fail closed", async () => {
  for (const tools of [
    [queryTool({ annotations: { readOnlyHint: true } })],
    [queryTool(), ...Array.from({ length: 63 }, (_, index) => queryTool({ name: `hidden-${index}` })), queryTool()],
  ]) {
    const { store } = storeWithBacking();
    const remote = fakeServerFetch({ tools });
    const service = createMcpToolService({ servers: store, fetchImpl: remote.fetch, refreshIntervalMs: 3_600_000 });
    await store.put(server());
    await service.refresh();
    assert.deepEqual(service.toolDefs(), []);
    service.close();
  }
});

test("tool service exposes only exact allowed tools and trusts reads only under all contracts", async () => {
  const { store } = storeWithBacking();
  const remote = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: remote.fetch, refreshIntervalMs: 3_600_000 });
  await store.put(server());
  await service.refresh();
  assert.deepEqual(
    service.toolDefs().map((tool) => ({
      name: tool.name,
      label: tool.label,
      status: tool.status,
      description: tool.description,
      readOnly: tool.readOnly,
    })),
    [
      {
        name: "crm_query",
        label: "Search CRM",
        status: "Searching the CRM",
        description: "Searching the CRM",
        readOnly: true,
      },
    ],
  );
  assert.equal(
    service.toolDefs().some((tool) => tool.remoteName === "update"),
    false,
  );
  assert.equal(await service.call("crm_query", { q: "hello" }, "internal:U1"), "ran query");
  remote.setTools([queryTool({ annotations: { readOnlyHint: false, destructiveHint: true } }), updateTool]);
  await service.refresh();
  assert.deepEqual(service.toolDefs(), []);
  remote.setTools([queryTool(), updateTool]);
  await store.put(server({ readOnly: false, updatedAt: 2 }));
  await service.refresh();
  assert.equal(service.toolDefs()[0]!.readOnly, false);
  service.close();
});

test("tool service rejects list-to-call schema and safety drift before tools/call", async () => {
  for (const changed of [
    queryTool({ inputSchema: { type: "object", properties: { account: { type: "string" } } } }),
    queryTool({ annotations: { readOnlyHint: false, destructiveHint: true } }),
    updateTool,
  ]) {
    const { store } = storeWithBacking();
    const remote = fakeServerFetch({ tools: [queryTool()] });
    const audit = createAuditLog();
    const service = createMcpToolService({
      servers: store,
      fetchImpl: remote.fetch,
      audit,
      refreshIntervalMs: 3_600_000,
    });
    await store.put(server());
    await service.refresh();
    remote.setTools([{ ...changed, name: "query" }]);
    await assert.rejects(() => service.call("crm_query", {}, "internal:U1"), /contract changed/);
    assert.equal(
      remote.calls.some((call) => call.rpc === "tools/call"),
      false,
    );
    const events = await audit.events();
    assert.ok(events.some((event) => event.action === "mcp.call" && event.status === "error"));
    assert.equal(
      events.some((event) => event.action === "mcp.call" && event.status === "ok"),
      false,
    );
    service.close();
  }
});

test("disable, delete, or same-millisecond contract rotation during preflight prevents dispatch", async () => {
  for (const action of ["disable", "delete", "rotate"] as const) {
    const { store } = storeWithBacking();
    let armed = false;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const methods: string[] = [];
    const fetch: McpFetch = async (_url, init) => {
      const request = JSON.parse(init.body) as { id: number; method: string };
      methods.push(request.method);
      if (request.method === "tools/list" && armed) {
        armed = false;
        entered();
        await waiting;
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "tools/list"
            ? { tools: [queryTool()] }
            : { content: [{ type: "text", text: "late result" }] },
      });
    };
    const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3_600_000 });
    await store.put(server());
    await service.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    armed = true;
    const call = service.call("crm_query", {});
    await started;
    if (action === "disable") await store.put(server({ enabled: false, updatedAt: 2 }));
    else if (action === "delete") await store.delete("crm");
    else await store.put(server({ url: "https://rotated.example.com/mcp", updatedAt: 1 }));
    release();
    await assert.rejects(() => call, /contract changed/);
    assert.equal(methods.filter((method) => method === "tools/call").length, 0);
    service.close();
  }
});

test("tool service validates arguments against the pinned schema before any remote call", async () => {
  const { store } = storeWithBacking();
  const remote = fakeServerFetch({ tools: [queryTool()] });
  const service = createMcpToolService({ servers: store, fetchImpl: remote.fetch, refreshIntervalMs: 3_600_000 });
  await store.put(server());
  await service.refresh();
  const callsBefore = remote.calls.length;
  await assert.rejects(() => service.call("crm_query", { q: 7 }), /arguments do not match/);
  assert.equal(remote.calls.length, callsBefore);
  service.close();
});

test("MCP string bounds count Unicode code points instead of UTF-16 units", async () => {
  const inputSchema = {
    type: "object",
    properties: { q: { type: "string", minLength: 1, maxLength: 1 } },
    required: ["q"],
    additionalProperties: false,
  };
  const tool = queryTool({ inputSchema });
  const { store } = storeWithBacking();
  const remote = fakeServerFetch({ tools: [tool] });
  const service = createMcpToolService({ servers: store, fetchImpl: remote.fetch, refreshIntervalMs: 3_600_000 });
  await store.put(server({ allowedTools: [{ ...allowed()[0]!, inputSchema }] }));
  await service.refresh();
  assert.equal(await service.call("crm_query", { q: "😀" }), "ran query");
  await assert.rejects(() => service.call("crm_query", { q: "😀😀" }), /arguments do not match/);
  service.close();
});

test("MCP numeric validation follows JSON Schema integer and numeric equality", async () => {
  const integer = 9_007_199_254_740_992;
  const inputSchema = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: integer, maximum: integer },
      zero: { type: "number", const: 0 },
    },
    required: ["count", "zero"],
    additionalProperties: false,
  };
  const tool = queryTool({ inputSchema });
  const { store } = storeWithBacking();
  const remote = fakeServerFetch({ tools: [tool] });
  const service = createMcpToolService({ servers: store, fetchImpl: remote.fetch, refreshIntervalMs: 3_600_000 });
  await store.put(server({ allowedTools: [{ ...allowed()[0]!, inputSchema }] }));
  await service.refresh();
  assert.equal(await service.call("crm_query", { count: integer, zero: -0 }), "ran query");
  service.close();
});

test("an older slow refresh cannot restore tools after a newer disable refresh", async () => {
  const { store } = storeWithBacking();
  await store.put(server());
  let armed = false;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const fetch: McpFetch = async (_url, init) => {
    const request = JSON.parse(init.body) as { id: number; method: string };
    if (request.method === "tools/list" && armed) {
      armed = false;
      entered();
      await waiting;
    }
    return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [queryTool()] } });
  };
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3_600_000 });
  await service.refresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  armed = true;
  const oldRefresh = service.refresh();
  await started;
  await store.put(server({ enabled: false, updatedAt: 2 }));
  await service.refresh();
  assert.deepEqual(service.toolDefs(), []);
  release();
  await oldRefresh;
  assert.deepEqual(service.toolDefs(), []);
  service.close();
});

test("MCP audit outcomes never persist arguments, credentials, or remote error text", async () => {
  const { store } = storeWithBacking();
  const remote = fakeServerFetch({ callError: "remote-secret-error" });
  const audit = createAuditLog();
  const service = createMcpToolService({
    servers: store,
    fetchImpl: remote.fetch,
    audit,
    refreshIntervalMs: 3_600_000,
  });
  await store.put(server({ auth: "bearer", bearerToken: "credential-secret", credentialState: "ready" }));
  await service.refresh();
  await assert.rejects(() => service.call("crm_query", { q: "argument-secret" }, "internal:U1"));
  const persisted = JSON.stringify(await audit.events());
  assert.doesNotMatch(persisted, /credential-secret|argument-secret|remote-secret-error/);
  assert.match(persisted, /"action":"mcp.call"/);
  assert.match(persisted, /"status":"error"/);
  service.close();
});

test("disabled, re-entry, and unknown tools remain unavailable", async () => {
  const { store } = storeWithBacking();
  const remote = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: remote.fetch, refreshIntervalMs: 3_600_000 });
  await store.put(server({ enabled: false }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 0);
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool/);
  service.close();
});

test("server id validation remains closed", () => {
  assert.ok(isValidMcpServerId("salesforce"));
  assert.ok(isValidMcpServerId("crm-2"));
  assert.ok(!isValidMcpServerId("Nope"));
  assert.ok(!isValidMcpServerId("x"));
  assert.ok(!isValidMcpServerId("has space"));
});
