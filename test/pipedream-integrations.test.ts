import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { commandApprovalId } from "../src/core/approval-id.ts";
import { createIntegrationConnectionStore } from "../src/integrations/integration-store.ts";
import { PipedreamClient, type PipedreamAccount } from "../src/integrations/pipedream-client.ts";
import { PipedreamBrokerClient } from "../src/integrations/pipedream-broker-client.ts";
import { createPipedreamIntegrationService } from "../src/integrations/pipedream-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

interface RequestLog {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null;
}

function fixture(options: { connectLinkUrl?: string; apps?: unknown[] } = {}) {
  const requests: RequestLog[] = [];
  const account = {
    id: "apn_123",
    name: "Acme HubSpot",
    external_id: "",
    healthy: true,
    dead: false,
    app: { name_slug: "hubspot", name: "HubSpot", img_src: "https://example.test/hubspot.png" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const tools = [
    {
      name: "find_contact",
      description: "Find a contact",
      inputSchema: { type: "object", properties: { email: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: "create_contact",
      description: "Create a contact",
      inputSchema: { type: "object", properties: { email: { type: "string" } } },
      annotations: { readOnlyHint: false },
    },
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    requests.push({ url, method, headers, body, signal: init?.signal ?? null });
    if (url.endsWith("/v1/oauth/token")) {
      return Response.json({ access_token: "pd_access", expires_in: 3600 });
    }
    if (url.endsWith("/tokens")) {
      return Response.json({
        connect_link_url: options.connectLinkUrl ?? "https://pipedream.test/_static/connect.html?connectLink=true",
        expires_at: "soon",
        token: "ctok",
      });
    }
    if (url.includes("/v1/connect/apps?")) {
      return Response.json({
        data: options.apps ?? [
          {
            name_slug: "highlevel_oauth",
            name: "GoHighLevel",
            description: "CRM and marketing automation",
          },
          { name_slug: "", name: "Invalid" },
        ],
      });
    }
    if (url.includes("/accounts?") && method === "GET") return Response.json({ data: [account] });
    if (url.includes("/accounts/apn_123") && method === "GET") {
      return Response.json({ ...account, external_id: client.externalUserId("slack:U123") });
    }
    if (url.includes("/accounts/apn_123") && method === "DELETE") return new Response(null, { status: 204 });
    if (url === "https://mcp.test/v3") {
      const result =
        body.method === "tools/list" ? { tools } : { content: [{ type: "text", text: "contact created" }] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  const client = new PipedreamClient(
    {
      clientId: "client",
      clientSecret: "secret",
      projectId: "proj_test",
      environment: "development",
      externalIdSecret: "external-secret",
      apiUrl: "https://api.test",
      mcpUrl: "https://mcp.test/v3",
      connectOrigin: "https://pipedream.test",
    },
    fetchImpl,
    () => 1_000_000,
  );
  return { client, requests };
}

test("Pipedream broker client sends only tenant-scoped requests", async () => {
  const requests: RequestLog[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
      signal: init?.signal ?? null,
    });
    if (String(input).includes("/apps?")) return Response.json({ apps: [{ nameSlug: "airtable", name: "Airtable" }] });
    if (String(input).endsWith("/connect-link")) {
      return Response.json({ url: "https://pipedream.com/_static/connect.html?token=ctok", expires_at: "soon" });
    }
    if (String(input).includes("/accounts?")) {
      return Response.json({
        accounts: [
          {
            id: "apn_123",
            name: "Acme",
            management_owner_id: "owner@acme.test",
            healthy: true,
            dead: false,
            app: { name_slug: "airtable", name: "Airtable" },
            target: { type: "base", id: "base_123", name: "Sales CRM", verified: true },
            created_at: "now",
            updated_at: "now",
          },
        ],
      });
    }
    if (String(input).endsWith("/tools/list")) return Response.json({ tools: [] });
    if (String(input).endsWith("/tools/call")) return Response.json({ result: "ok" });
    return new Response(null, { status: 204 });
  };
  const client = new PipedreamBrokerClient(
    {
      url: "https://gateway.test/integrations",
      token: "tenant_scoped_token",
      externalIdSecret: "external-secret",
    },
    fetchImpl,
  );
  await client.listApps("airtable");
  await client.createConnectLink("slack:U123", "airtable", "https://portal.test/integrations");
  const [account] = await client.listAccounts("slack:U123");
  assert.equal(client.managementOwnerId(account!, "slack:U123"), "owner@acme.test");
  assert.deepEqual(account?.target, { type: "base", id: "base_123", name: "Sales CRM", verified: true });
  await client.listTools({
    externalUserId: client.externalUserId("slack:U123"),
    ownerId: "slack:U123",
    accountId: account!.id,
    appSlug: account!.app.name_slug,
  });
  await client.callTool(
    {
      externalUserId: client.externalUserId("slack:U123"),
      ownerId: "slack:U123",
      accountId: account!.id,
      appSlug: account!.app.name_slug,
      target: account!.target,
    },
    "find_records",
    { table: "Leads" },
  );
  await client.deleteAccount("slack:U123", account!.id);
  assert.ok(requests.every((request) => request.headers.get("authorization") === "Bearer tenant_scoped_token"));
  assert.ok(requests.every((request) => !request.url.includes("client_secret")));
  assert.equal(requests.find((request) => request.url.endsWith("/tools/call"))?.body.principal_id, "slack:U123");
  assert.equal(requests.find((request) => request.url.endsWith("/tools/call"))?.body.target_id, "base_123");
});

test("Pipedream broker client rejects untrusted Connect links", async () => {
  const client = new PipedreamBrokerClient(
    {
      url: "https://gateway.test/integrations",
      token: "tenant_scoped_token",
      externalIdSecret: "external-secret",
    },
    async () => Response.json({ url: "https://attacker.test/_static/connect.html?token=stolen" }),
  );
  await assert.rejects(() => client.createConnectLink("slack:U123", "airtable"), /invalid link/);
});

test("Pipedream refuses to delete an account owned by another external user", async () => {
  const { client, requests } = fixture();
  await assert.rejects(() => client.deleteAccount("slack:other", "apn_123"), /does not belong/);
  assert.equal(
    requests.some((request) => request.method === "DELETE"),
    false,
  );
});

test("Pipedream client scopes Connect links and account reads to an opaque external user", async () => {
  const { client, requests } = fixture();
  const externalId = client.externalUserId("slack:U123");
  assert.match(externalId, /^qm_[0-9a-f]{40}$/);
  assert.ok(!externalId.includes("U123"));
  const apps = await client.listApps(" high level ");
  assert.deepEqual(apps, [
    { nameSlug: "highlevel_oauth", name: "GoHighLevel", description: "CRM and marketing automation" },
  ]);
  const appRequest = requests.find((request) => request.url.includes("/v1/connect/apps?"));
  assert.ok(appRequest?.url.includes("q=high+level"));
  assert.ok(appRequest?.url.includes("has_actions=true"));
  const link = await client.createConnectLink("slack:U123", "highlevel_oauth", "https://portal.test/integrations");
  assert.equal(link.url, "https://pipedream.test/_static/connect.html?connectLink=true&app=highlevel_oauth");
  const tokenRequest = requests.find((request) => request.url.endsWith("/tokens"));
  assert.equal(tokenRequest?.body.external_user_id, externalId);
  assert.equal(tokenRequest?.body.scope, "connect:accounts:read connect:accounts:write");
  const oauthRequest = requests.find((request) => request.url.endsWith("/v1/oauth/token"));
  assert.equal(
    oauthRequest?.body.scope,
    "connect:accounts:read connect:accounts:write connect:tokens:create connect:actions:*",
  );
  const accounts = await client.listAccounts("slack:U123");
  assert.equal(accounts[0]?.id, "apn_123");
  const accountRequest = requests.find((request) => request.url.includes("/accounts?"));
  assert.ok(accountRequest?.url.includes(`external_user_id=${encodeURIComponent(externalId)}`));
  assert.ok(accountRequest?.url.includes("include_credentials=false"));
  assert.equal(requests.filter((request) => request.url.endsWith("/v1/oauth/token")).length, 1);
  assert.ok(requests.every((request) => request.signal instanceof AbortSignal));
});

test("Pipedream rejects missing and malformed apps before creating a Connect token", async () => {
  const { client, requests } = fixture();
  await assert.rejects(() => client.createConnectLink("slack:U123", ""), /valid integration app/);
  await assert.rejects(() => client.createConnectLink("slack:U123", "hubspot?redirect=evil"), /valid integration app/);
  assert.equal(requests.length, 0);
});

test("Pipedream rejects Connect capability URLs outside its exact trusted surface", async () => {
  for (const connectLinkUrl of [
    "https://attacker.test/_static/connect.html?connectLink=true",
    "https://pipedream.test/other?connectLink=true",
    "https://user@pipedream.test/_static/connect.html?connectLink=true",
    "https://pipedream.test/_static/connect.html?connectLink=true#fragment",
  ]) {
    const { client } = fixture({ connectLinkUrl });
    await assert.rejects(() => client.createConnectLink("slack:U123", "highlevel_oauth"), /invalid link/);
  }
});

test("Pipedream caps normalized app search results even when the provider exceeds its limit", async () => {
  const apps = Array.from({ length: 50 }, (_, index) => ({ name_slug: `app_${index}`, name: `App ${index}` }));
  const { client } = fixture({ apps });
  const results = await client.listApps("");
  assert.equal(results.length, 20);
  assert.equal(results.at(-1)?.nameSlug, "app_19");
});

test("integration service refuses malformed app names without persisting them in audit", async () => {
  const { client, requests } = fixture();
  const audit = createAuditLog();
  const service = createPipedreamIntegrationService({
    client,
    store: createIntegrationConnectionStore(createMemoryMap()),
    audit,
    approvalSecret: "approval-secret",
  });
  await assert.rejects(() => service.createConnectLink("slack:U123", "x".repeat(10_000)), /valid integration app/);
  assert.equal(requests.length, 0);
  const [event] = await audit.events();
  assert.deepEqual(
    { action: event?.action, resource: event?.resource, status: event?.status },
    { action: "integration.connect.start", resource: "pipedream", status: "refused" },
  );
});

test("Pipedream MCP calls use the selected account and never materialize its credentials", async () => {
  const { client, requests } = fixture();
  const connection = {
    externalUserId: client.externalUserId("slack:U123"),
    accountId: "apn_123",
    appSlug: "hubspot",
  };
  const tools = await client.listTools(connection);
  assert.deepEqual(
    tools.map(({ name }) => name),
    ["find_contact", "create_contact"],
  );
  assert.equal(await client.callTool(connection, "create_contact", { email: "a@example.com" }), "contact created");
  const mcpRequests = requests.filter((request) => request.url === "https://mcp.test/v3");
  assert.equal(mcpRequests[0]?.headers.get("x-pd-account-id"), "apn_123");
  assert.equal(mcpRequests[0]?.headers.get("x-pd-app-slug"), "hubspot");
  assert.equal(mcpRequests[0]?.headers.get("authorization"), "Bearer pd_access");
});

test("integration policy defaults to personal read-only and gates every external call", async () => {
  const { client } = fixture();
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({
    client,
    store,
    approvalSecret: "approval-secret",
    now: () => 2_000_000,
  });
  const [connection] = await service.listOwned("slack:U123");
  assert.equal(connection?.access, "read");
  assert.deepEqual(connection?.scopes, ["personal:slack:U123"]);
  assert.match(
    (
      await service.approvalFor!(
        "integrations",
        { action: "call_tool", account_id: "apn_123", tool: "find_contact" },
        "slack:U123",
        "personal:slack:U123",
      )
    )?.approvalKey ?? "",
    /^integration:apn_123:find_contact:/,
  );
  await assert.rejects(
    () =>
      service.approvalFor!(
        "integrations",
        { action: "call_tool", account_id: "apn_123", tool: "create_contact" },
        "slack:U123",
        "personal:slack:U123",
      ),
    /read-only/,
  );
  await assert.rejects(
    () =>
      service.call(
        "integrations",
        { action: "call_tool", account_id: "apn_123", tool: "create_contact" },
        "slack:U123",
        "personal:slack:U123",
      ),
    /read-only/,
  );
  await assert.rejects(
    () =>
      service.call("integrations", { action: "list_tools", account_id: "apn_123" }, "slack:U123", "channel:UNSHARED"),
    /No authorized connected account/,
  );
  await service.updateOwned("slack:U123", "apn_123", {
    access: "read-write",
    scopes: ["channel:C123"],
  });
  const writeApproval = await service.approvalFor!(
    "integrations",
    { action: "call_tool", account_id: "apn_123", tool: "create_contact" },
    "slack:U999",
    "channel:C123",
  );
  assert.match(
    writeApproval?.reason ?? "",
    /hubspot\/create_contact on Acme_HubSpot \(apn_123\) with 0 argument fields/,
  );
  assert.match(writeApproval?.approvalKey ?? "", /^integration:apn_123:create_contact:[0-9a-f]{24}$/);
  assert.match(writeApproval?.command ?? "", /^integration hubspot\/create_contact/);
  const result = await service.call(
    "integrations",
    { action: "call_tool", account_id: "apn_123", tool: "create_contact", arguments: { email: "a@example.com" } },
    "slack:U999",
    "channel:C123",
  );
  assert.equal(result, "contact created");
  service.close();
});

test("broker integrations are company-wide while management and audit retain the acting person", async () => {
  const { client } = fixture();
  const store = createIntegrationConnectionStore(createMemoryMap());
  const toolActors: string[] = [];
  const callActors: string[] = [];
  const listTools = client.listTools.bind(client);
  const callTool = client.callTool.bind(client);
  Object.assign(client, { managementOwnerId: () => "web:owner@acme.test" });
  client.listTools = async (connection) => {
    toolActors.push((connection as typeof connection & { ownerId: string }).ownerId);
    return listTools(connection);
  };
  client.callTool = async (connection, name, args) => {
    callActors.push((connection as typeof connection & { ownerId: string }).ownerId);
    return callTool(connection, name, args);
  };
  const service = createPipedreamIntegrationService({
    client,
    store,
    approvalSecret: "approval-secret",
    sharedScopeId: "org:acme",
  });
  await service.call("integrations", { action: "list_accounts" }, "slack:U999", "channel:C1");
  await service.updateOwned("web:owner@acme.test", "apn_123", { access: "read-write" });
  assert.deepEqual(
    JSON.parse(await service.call("integrations", { action: "list_accounts" }, "slack:U999", "channel:C1")),
    [
      {
        account_id: "apn_123",
        app: "hubspot",
        app_name: "HubSpot",
        account: "Acme HubSpot",
        healthy: true,
        access: "read-write",
      },
    ],
  );
  assert.equal(
    await service.call(
      "integrations",
      { action: "call_tool", account_id: "apn_123", tool: "create_contact" },
      "slack:U999",
      "channel:C1",
    ),
    "contact created",
  );
  const connection = await store.get("apn_123");
  assert.equal(connection?.ownerId, "web:owner@acme.test");
  assert.deepEqual(connection?.scopes, ["org:acme"]);
  assert.equal(connection?.access, "read-write");
  assert.deepEqual(toolActors, ["slack:U999"]);
  assert.deepEqual(callActors, ["slack:U999"]);
  assert.equal(await service.updateOwned("slack:U999", "apn_123", { access: "read" }), null);
  assert.equal(await service.deleteOwned("slack:U999", "apn_123"), false);
});

test("direct HighLevel accounts remain usable without broker target attestations", async () => {
  const client = {
    externalUserId: () => "tenant",
    listApps: async () => [],
    createConnectLink: async () => ({ url: "https://pipedream.com/_static/connect.html", expiresAt: "soon" }),
    listAccounts: async (): Promise<PipedreamAccount[]> => [
      {
        id: "apn_direct_highlevel",
        name: "HighLevel",
        healthy: true,
        dead: false,
        app: { name_slug: "highlevel_oauth", name: "HighLevel" },
        created_at: "2026-08-25T10:00:00Z",
        updated_at: "2026-08-25T10:00:00Z",
      },
    ],
    deleteAccount: async () => {},
    listTools: async () => [
      { name: "find_contact", description: "Find contact", inputSchema: { type: "object" }, readOnly: true },
    ],
    callTool: async () => "found",
  };
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  const [connection] = await service.listOwned("owner@acme.test");
  assert.equal(connection?.targetRequired, undefined);
  assert.equal(
    await service.call(
      "integrations",
      { action: "call_tool", account_id: "apn_direct_highlevel", tool: "find_contact" },
      "owner@acme.test",
      "personal:owner@acme.test",
    ),
    "found",
  );
  service.close();
});

test("HighLevel writes name the verified sub-account and fail closed without it", async () => {
  const target = { type: "location", id: "location_123", name: "Acme Dental - Miami", verified: true as const };
  const account = {
    id: "apn_highlevel",
    name: "HighLevel",
    healthy: true,
    dead: false,
    app: { name_slug: "highlevel_oauth", name: "HighLevel" },
    created_at: "2026-08-25T10:00:00Z",
    updated_at: "2026-08-25T10:00:00Z",
    target_required: true,
    target,
  };
  const tool = {
    name: "highlevel_oauth-create-contact",
    description: "Create contact",
    inputSchema: { type: "object" },
    readOnly: false,
  };
  let currentTarget: typeof target | undefined = target;
  let currentUpdatedAt = account.updated_at;
  let failCall = false;
  const client = {
    externalUserId: () => "tenant",
    listApps: async () => [],
    createConnectLink: async () => ({ url: "https://pipedream.com/_static/connect.html", expiresAt: "soon" }),
    listAccounts: async () => [{ ...account, updated_at: currentUpdatedAt, target: currentTarget }],
    deleteAccount: async () => {},
    listTools: async () => [tool],
    callTool: async () => {
      if (failCall) throw new Error("provider failed");
      return "created";
    },
  };
  const store = createIntegrationConnectionStore(createMemoryMap());
  const audit = createAuditLog();
  const service = createPipedreamIntegrationService({ client, store, audit, approvalSecret: "approval-secret" });
  await service.listOwned("owner@acme.test");
  await service.updateOwned("owner@acme.test", account.id, { access: "read-write" });
  const listed = JSON.parse(
    await service.call("integrations", { action: "list_accounts" }, "owner@acme.test", "personal:owner@acme.test"),
  );
  assert.deepEqual(listed[0], {
    account_id: "apn_highlevel",
    app: "highlevel_oauth",
    app_name: "HighLevel",
    account: "HighLevel",
    target_required: true,
    target_type: "location",
    target_id: "location_123",
    target_name: "Acme Dental - Miami",
    target_verified: true,
    healthy: true,
    access: "read-write",
  });
  const approval = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: account.id,
      target_id: "location_123",
      tool: tool.name,
      arguments: { email: "lead@example.com" },
    },
    "owner@acme.test",
    "personal:owner@acme.test",
  );
  assert.match(approval?.reason ?? "", /verified location Acme_Dental_-_Miami \(location_123\).*lead@example\.com/);
  assert.equal(
    await service.call(
      "integrations",
      { action: "call_tool", account_id: account.id, target_id: "location_123", tool: tool.name },
      "owner@acme.test",
      "personal:owner@acme.test",
    ),
    "created",
  );
  failCall = true;
  await assert.rejects(
    () =>
      service.call(
        "integrations",
        { action: "call_tool", account_id: account.id, target_id: "location_123", tool: tool.name },
        "owner@acme.test",
        "personal:owner@acme.test",
      ),
    /provider failed/,
  );
  const targetedCalls = (await audit.events()).filter(
    (event) => event.action === "integration.tool.call" && event.detail?.includes('"target_id":"location_123"'),
  );
  assert.deepEqual(
    targetedCalls.map((event) => event.status),
    ["ok", "failed"],
  );
  currentTarget = { ...target, id: "location_456", name: "Acme Dental - Orlando" };
  currentUpdatedAt = "2026-08-25T11:00:00Z";
  await service.listOwned("owner@acme.test");
  assert.equal((await store.get(account.id))?.target, undefined);
  assert.equal((await store.get(account.id))?.lastVerifiedTargetId, "location_123");
  await assert.rejects(
    () =>
      service.call(
        "integrations",
        { action: "call_tool", account_id: account.id, target_id: "location_456", tool: tool.name },
        "owner@acme.test",
        "personal:owner@acme.test",
      ),
    /current verified target_id/,
  );
  currentTarget = { ...target, name: "Acme Dental renamed" };
  currentUpdatedAt = "2026-08-25T12:00:00Z";
  await service.listOwned("owner@acme.test");
  assert.deepEqual((await store.get(account.id))?.target, {
    ...target,
    name: "Acme Dental renamed",
  });
  currentTarget = undefined;
  currentUpdatedAt = "2026-08-25T13:00:00Z";
  await service.listOwned("owner@acme.test");
  assert.equal((await store.get(account.id))?.target, undefined);
  await assert.rejects(
    () =>
      service.approvalFor!(
        "integrations",
        { action: "call_tool", account_id: account.id, tool: tool.name },
        "owner@acme.test",
        "personal:owner@acme.test",
      ),
    /current verified target_id/,
  );
  await assert.rejects(
    () =>
      service.call(
        "integrations",
        { action: "call_tool", account_id: account.id, tool: tool.name },
        "owner@acme.test",
        "personal:owner@acme.test",
      ),
    /current verified target_id/,
  );
  assert.deepEqual(
    (await audit.events())
      .filter((event) => event.status === "refused" && event.detail?.includes("target_unverified"))
      .map((event) => event.action),
    ["integration.tool.call", "integration.tool.authorize", "integration.tool.call"],
  );
  service.close();
});

test("verified generic targets bind reads and clear when the provider retracts them", async () => {
  const targetId = `base_${"x".repeat(300)}`;
  let target: PipedreamAccount["target"] = { type: "base", id: targetId, name: "Sales", verified: true };
  let updatedAt = "2026-08-25T10:00:00Z";
  const account: PipedreamAccount = {
    id: "apn_airtable",
    name: "Airtable",
    healthy: true,
    dead: false,
    app: { name_slug: "airtable", name: "Airtable" },
    created_at: "now",
    updated_at: updatedAt,
    target,
  };
  const client = {
    externalUserId: () => "tenant",
    listApps: async () => [],
    createConnectLink: async () => ({ url: "https://pipedream.com/_static/connect.html", expiresAt: "soon" }),
    listAccounts: async () => [{ ...account, updated_at: updatedAt, target }],
    deleteAccount: async () => {},
    listTools: async () => [
      { name: "list_records", description: "List records", inputSchema: { type: "object" }, readOnly: true },
    ],
    callTool: async () => "listed",
  };
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  await service.listOwned("owner@acme.test");
  await assert.rejects(
    () =>
      service.approvalFor!(
        "integrations",
        { action: "call_tool", account_id: account.id, tool: "list_records" },
        "owner@acme.test",
        "personal:owner@acme.test",
      ),
    /current verified target_id/,
  );
  const approval = await service.approvalFor!(
    "integrations",
    { action: "call_tool", account_id: account.id, target_id: targetId, tool: "list_records" },
    "owner@acme.test",
    "personal:owner@acme.test",
  );
  assert.match(approval?.reason ?? "", /~[0-9a-f]{12}\)/);
  assert.equal((await store.get(account.id))?.target?.id, targetId);
  target = undefined;
  updatedAt = "2026-08-25T11:00:00Z";
  await service.listOwned("owner@acme.test");
  assert.equal((await store.get(account.id))?.target, undefined);
  target = { type: "base", id: targetId, name: "Sales renamed", verified: true };
  updatedAt = "2026-08-25T12:00:00Z";
  await service.listOwned("owner@acme.test");
  assert.deepEqual((await store.get(account.id))?.target, {
    type: "base",
    id: targetId,
    name: "Sales renamed",
    verified: true,
  });
  service.close();
});

test("same-version target conflicts stay blocked until a newer attestation", async () => {
  const account = (id: string, updatedAt: string): PipedreamAccount => ({
    id: "apn_highlevel",
    name: "HighLevel",
    healthy: true,
    dead: false,
    app: { name_slug: "highlevel_oauth", name: "HighLevel" },
    created_at: "2026-08-25T09:00:00Z",
    updated_at: updatedAt,
    target_required: true,
    target: { type: "location", id, name: id, verified: true },
  });
  const client = (value: PipedreamAccount) => ({
    externalUserId: () => "tenant",
    managementOwnerId: () => "owner@acme.test",
    listApps: async () => [],
    createConnectLink: async () => ({ url: "https://pipedream.com/_static/connect.html", expiresAt: "soon" }),
    listAccounts: async () => [value],
    deleteAccount: async () => {},
    listTools: async () => [],
    callTool: async () => "",
  });
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = (value: PipedreamAccount) =>
    createPipedreamIntegrationService({
      client: client(value),
      store,
      approvalSecret: "approval-secret",
      sharedScopeId: "org:acme",
    });
  const trusted = service(account("location_a", "2026-08-25T10:00:00Z"));
  await trusted.listOwned("slack:U1");
  const conflict = service(account("location_b", "2026-08-25T10:00:00Z"));
  await conflict.listOwned("slack:U2");
  assert.equal((await store.get("apn_highlevel"))?.target, undefined);
  await trusted.listOwned("slack:U1");
  assert.equal((await store.get("apn_highlevel"))?.target, undefined);
  const recovered = service(account("location_a", "2026-08-25T11:00:00Z"));
  await recovered.listOwned("slack:U3");
  assert.equal((await store.get("apn_highlevel"))?.target?.id, "location_a");
  trusted.close();
  conflict.close();
  recovered.close();
});

test("a stale provider sync cannot revert a newer verified target", async () => {
  let releaseStale: (() => void) | undefined;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  const account = (id: string, updatedAt: string): PipedreamAccount => ({
    id: "apn_highlevel",
    name: "HighLevel",
    healthy: true,
    dead: false,
    app: { name_slug: "highlevel_oauth", name: "HighLevel" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: updatedAt,
    target_required: true,
    target: { type: "location", id, name: id, verified: true },
  });
  const client = (value: PipedreamAccount, gate?: Promise<void>) => ({
    externalUserId: () => "tenant",
    managementOwnerId: () => "owner@acme.test",
    listApps: async () => [],
    createConnectLink: async () => ({ url: "https://pipedream.com/_static/connect.html", expiresAt: "soon" }),
    listAccounts: async () => {
      if (gate) await gate;
      return [value];
    },
    deleteAccount: async () => {},
    listTools: async () => [],
    callTool: async () => "",
  });
  const store = createIntegrationConnectionStore(createMemoryMap());
  const stale = createPipedreamIntegrationService({
    client: client(account("location_old", "2026-08-25T10:00:00Z"), staleGate),
    store,
    approvalSecret: "approval-secret",
    sharedScopeId: "org:acme",
  });
  const current = createPipedreamIntegrationService({
    client: client(account("location_new", "2026-08-25T11:00:00Z")),
    store,
    approvalSecret: "approval-secret",
    sharedScopeId: "org:acme",
  });
  const staleSync = stale.listOwned("slack:U1");
  await current.listOwned("slack:U2");
  releaseStale!();
  await staleSync;
  assert.equal((await store.get("apn_highlevel"))?.target?.id, "location_new");
  stale.close();
  current.close();
});

test("unversioned provider accounts can become unhealthy without reviving trust", async () => {
  let healthy = true;
  let target: PipedreamAccount["target"] = { type: "base", id: "base_1", name: "Base", verified: true };
  const client = {
    externalUserId: () => "tenant",
    listApps: async () => [],
    createConnectLink: async () => ({ url: "https://pipedream.com/_static/connect.html", expiresAt: "soon" }),
    listAccounts: async (): Promise<PipedreamAccount[]> => [
      {
        id: "apn_unversioned",
        name: "Airtable",
        healthy,
        dead: false,
        app: { name_slug: "airtable", name: "Airtable" },
        created_at: "",
        updated_at: "",
        target,
      },
    ],
    deleteAccount: async () => {},
    listTools: async () => [],
    callTool: async () => "",
  };
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  await service.listOwned("owner@acme.test");
  healthy = false;
  target = { type: "base", id: "base_2", name: "Other", verified: true };
  await service.listOwned("owner@acme.test");
  const connection = await store.get("apn_unversioned");
  assert.equal(connection?.healthy, false);
  assert.equal(connection?.target, undefined);
  healthy = true;
  await service.listOwned("owner@acme.test");
  assert.equal((await store.get("apn_unversioned"))?.healthy, false);
  service.close();
});

test("same-version provider accounts can become unhealthy and padded targets fail closed", async () => {
  let healthy = true;
  let target: PipedreamAccount["target"] = { type: "location", id: "location_1", name: "Main", verified: true };
  const client = {
    externalUserId: () => "tenant",
    listApps: async () => [],
    createConnectLink: async () => ({ url: "https://pipedream.com/_static/connect.html", expiresAt: "soon" }),
    listAccounts: async (): Promise<PipedreamAccount[]> => [
      {
        id: "apn_highlevel",
        name: "HighLevel",
        healthy,
        dead: false,
        app: { name_slug: "highlevel_oauth", name: "HighLevel" },
        created_at: "2026-08-25T10:00:00Z",
        updated_at: "2026-08-25T10:00:00Z",
        target,
      },
    ],
    deleteAccount: async () => {},
    listTools: async () => [],
    callTool: async () => "",
  };
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  await service.listOwned("owner@acme.test");
  healthy = false;
  await service.listOwned("owner@acme.test");
  assert.equal((await store.get("apn_highlevel"))?.healthy, false);
  target = { ...target, id: " location_1 " };
  await service.listOwned("owner@acme.test");
  assert.equal((await store.get("apn_highlevel"))?.target, undefined);
  service.close();
});

test("provider read-only hints permit reads but never bypass human approval", async () => {
  const { client } = fixture();
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  await service.listOwned("slack:U123");
  const approval = await service.approvalFor!(
    "integrations",
    { action: "call_tool", account_id: "apn_123", tool: "find_contact" },
    "slack:U123",
    "personal:slack:U123",
  );
  assert.match(approval?.approvalKey ?? "", /^integration:apn_123:find_contact:[0-9a-f]{24}$/);
  assert.equal(
    await service.call(
      "integrations",
      { action: "call_tool", account_id: "apn_123", tool: "find_contact" },
      "slack:U123",
      "personal:slack:U123",
    ),
    "contact created",
  );
});

test("approval identity binds canonical arguments and cannot collide in one batch", async () => {
  const { client } = fixture();
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  await service.listOwned("slack:U123");
  await service.updateOwned("slack:U123", "apn_123", { access: "read-write" });
  const approvalA = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: "apn_123",
      tool: "create_contact",
      arguments: { email: "a@example.com", tags: ["lead"], sk_live_sensitive_key: true },
    },
    "slack:U123",
    "personal:slack:U123",
  );
  const approvalAReordered = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: "apn_123",
      tool: "create_contact",
      arguments: { sk_live_sensitive_key: true, tags: ["lead"], email: "a@example.com" },
    },
    "slack:U123",
    "personal:slack:U123",
  );
  const approvalB = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: "apn_123",
      tool: "create_contact",
      arguments: { email: "b@example.com", tags: ["lead"] },
    },
    "slack:U123",
    "personal:slack:U123",
  );
  assert.equal(approvalA?.approvalKey, approvalAReordered?.approvalKey);
  assert.notEqual(approvalA?.approvalKey, approvalB?.approvalKey);
  assert.notEqual(
    commandApprovalId("session-1", approvalA?.command ?? ""),
    commandApprovalId("session-1", approvalB?.command ?? ""),
  );
  assert.match(approvalA?.reason ?? "", /a@example\.com/);
  assert.ok(!approvalA?.reason.includes("sk_live_sensitive_key"));
  assert.match(approvalA?.reason ?? "", /\[redacted\]/);
  assert.match(approvalA?.reason ?? "", /with 3 argument fields/);
  const semanticSecret = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: "apn_123",
      tool: "create_contact",
      arguments: { headers: [{ name: "Authorization", value: "Bearer sk_live_should_not_appear" }] },
    },
    "slack:U123",
    "personal:slack:U123",
  );
  assert.ok(!semanticSecret?.reason.includes("sk_live_should_not_appear"));
  assert.match(semanticSecret?.reason ?? "", /\[redacted\]/);
  const keyValueSecret = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: "apn_123",
      tool: "create_contact",
      arguments: { headers: [{ key: "Authorization", value: "Basic dXNlcjpwYXNz" }] },
    },
    "slack:U123",
    "personal:slack:U123",
  );
  assert.ok(!keyValueSecret?.reason.includes("dXNlcjpwYXNz"));
  const longDestination = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: "apn_123",
      tool: "create_contact",
      arguments: { destination: `${"x".repeat(320)}victim@example.com` },
    },
    "slack:U123",
    "personal:slack:U123",
  );
  assert.match(longDestination?.reason ?? "", /victim@example\.com/);
  const secretUrl = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: "apn_123",
      tool: "create_contact",
      arguments: { url: "https://example.test/hook?api_key=supersecretvalue&target=visible" },
    },
    "slack:U123",
    "personal:slack:U123",
  );
  assert.ok(!secretUrl?.reason.includes("supersecretvalue"));
  assert.match(secretUrl?.reason ?? "", /target=visible/);
  const signedUrl = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: "apn_123",
      tool: "create_contact",
      arguments: {
        download: "https://storage.example/object?signature=signedsecret",
        callback: "https://client.example/callback#access_token=fragmentsecret&state=visible",
      },
    },
    "slack:U123",
    "personal:slack:U123",
  );
  assert.ok(!signedUrl?.reason.includes("signedsecret"));
  assert.ok(!signedUrl?.reason.includes("fragmentsecret"));
  assert.match(signedUrl?.reason ?? "", /state=visible/);
  const embeddedKey = await service.approvalFor!(
    "integrations",
    {
      action: "call_tool",
      account_id: "apn_123",
      tool: "create_contact",
      arguments: {
        label: "prefix:sk_live_1234567890",
        callback: "https://evil.example/collect?padding=sk_live_1234567890&target=visible",
        instruction: "Basic transfer records to victim@example.com",
        recipients: "https://example.test/send?recipient=approved@example.com&recipient=victim@example.com",
      },
    },
    "slack:U123",
    "personal:slack:U123",
  );
  assert.ok(!embeddedKey?.reason.includes("sk_live_1234567890"));
  assert.match(embeddedKey?.reason ?? "", /evil\.example/);
  assert.match(embeddedKey?.reason ?? "", /target=visible/);
  assert.match(embeddedKey?.reason ?? "", /victim(?:@|%40)example\.com/);
  assert.match(embeddedKey?.reason ?? "", /approved(?:@|%40)example\.com/);
  await assert.rejects(
    () =>
      service.approvalFor!(
        "integrations",
        {
          action: "call_tool",
          account_id: "apn_123",
          tool: "create_contact",
          arguments: Object.fromEntries(
            Array.from({ length: 80 }, (_, index) => [`destination_${index}`, "x".repeat(20)]),
          ),
        },
        "slack:U123",
        "personal:slack:U123",
      ),
    /too large to disclose safely/,
  );
});

test("a late provider sync preserves a concurrent policy change", async () => {
  let releaseAccounts: (() => void) | undefined;
  const accountsGate = new Promise<void>((resolve) => {
    releaseAccounts = resolve;
  });
  const base = fixture();
  const originalListAccounts = base.client.listAccounts.bind(base.client);
  base.client.listAccounts = async (principalId) => {
    await accountsGate;
    return originalListAccounts(principalId);
  };
  const store = createIntegrationConnectionStore(createMemoryMap());
  await store.put({
    accountId: "apn_123",
    externalUserId: base.client.externalUserId("slack:U123"),
    ownerId: "slack:U123",
    appSlug: "hubspot",
    appName: "HubSpot",
    accountName: "Old name",
    healthy: true,
    scopes: ["personal:slack:U123"],
    access: "read",
    createdAt: 1,
    updatedAt: 1,
  });
  const service = createPipedreamIntegrationService({
    client: base.client,
    store,
    approvalSecret: "approval-secret",
    now: () => 99,
  });
  const syncing = service.listOwned("slack:U123");
  await service.updateOwned("slack:U123", "apn_123", { access: "read-write", scopes: ["channel:C123"] });
  releaseAccounts!();
  await syncing;
  const connection = await store.get("apn_123");
  assert.equal(connection?.access, "read-write");
  assert.deepEqual(connection?.scopes, ["personal:slack:U123", "channel:C123"]);
  assert.equal(connection?.accountName, "Acme HubSpot");
});

test("a stale sync from another instance cannot delete a newly connected account", async () => {
  let releaseStale: (() => void) | undefined;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  const stale = fixture();
  stale.client.listAccounts = async () => {
    await staleGate;
    return [];
  };
  const current = fixture();
  const store = createIntegrationConnectionStore(createMemoryMap());
  const staleService = createPipedreamIntegrationService({
    client: stale.client,
    store,
    approvalSecret: "approval-secret",
  });
  const currentService = createPipedreamIntegrationService({
    client: current.client,
    store,
    approvalSecret: "approval-secret",
  });
  const staleSync = staleService.listOwned("slack:U123");
  await currentService.listOwned("slack:U123");
  releaseStale!();
  await staleSync;
  assert.equal((await store.get("apn_123"))?.accountName, "Acme HubSpot");
});

test("a stale sync from another instance cannot resurrect a disconnected account", async () => {
  let releaseStale: (() => void) | undefined;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  const current = fixture();
  const stale = fixture();
  const staleList = stale.client.listAccounts.bind(stale.client);
  stale.client.listAccounts = async (principalId) => {
    const snapshot = await staleList(principalId);
    await staleGate;
    return snapshot;
  };
  const store = createIntegrationConnectionStore(createMemoryMap());
  const currentService = createPipedreamIntegrationService({
    client: current.client,
    store,
    approvalSecret: "approval-secret",
  });
  const staleService = createPipedreamIntegrationService({
    client: stale.client,
    store,
    approvalSecret: "approval-secret",
  });
  await currentService.listOwned("slack:U123");
  const staleSync = staleService.listOwned("slack:U123");
  assert.equal(await currentService.deleteOwned("slack:U123", "apn_123"), true);
  releaseStale!();
  await staleSync;
  const connection = await store.get("apn_123");
  assert.equal(connection?.healthy, false);
  assert.deepEqual(connection?.scopes, []);
  assert.ok(connection?.disconnectedAt);
});

test("disconnect hides the account before provider deletion and remains retryable", async () => {
  const { client } = fixture();
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  await service.listOwned("slack:U123");
  const providerDelete = client.deleteAccount.bind(client);
  let attempts = 0;
  client.deleteAccount = async (principalId, accountId) => {
    attempts += 1;
    await providerDelete(principalId, accountId);
    if (attempts === 1) throw new Error("provider response was lost");
  };
  await assert.rejects(() => service.deleteOwned("slack:U123", "apn_123"), /response was lost/);
  const disconnected = await store.get("apn_123");
  assert.equal(disconnected?.healthy, false);
  assert.deepEqual(disconnected?.scopes, []);
  assert.ok(disconnected?.disconnectedAt);
  assert.deepEqual(await service.listOwned("slack:U123"), []);
  assert.equal(attempts, 2);
});

test("a failed pending disconnect does not hide unrelated active accounts", async () => {
  const { client } = fixture();
  const providerList = client.listAccounts.bind(client);
  client.listAccounts = async (principalId) => [
    ...(await providerList(principalId)),
    {
      id: "apn_456",
      name: "Acme Sheets",
      healthy: true,
      dead: false,
      app: { name_slug: "google_sheets", name: "Google Sheets" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ];
  let attempts = 0;
  client.deleteAccount = async () => {
    attempts += 1;
    throw new Error("provider unavailable");
  };
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  assert.equal((await service.listOwned("slack:U123")).length, 2);
  await assert.rejects(() => service.deleteOwned("slack:U123", "apn_123"), /provider unavailable/);
  assert.deepEqual(
    (await service.listOwned("slack:U123")).map((connection) => connection.accountId),
    ["apn_456"],
  );
  assert.equal(attempts, 2);
  assert.deepEqual(
    (await service.listOwned("slack:U123")).map((connection) => connection.accountId),
    ["apn_456"],
  );
  assert.equal(attempts, 3);
});

test("disconnect never reaches the provider when its durable tombstone fails", async () => {
  const { client, requests } = fixture();
  const durable = createIntegrationConnectionStore(createMemoryMap());
  let failUpdate = false;
  const store = {
    ...durable,
    update: async (...args: Parameters<typeof durable.update>) => {
      if (failUpdate) throw new Error("durable write failed");
      return durable.update(...args);
    },
  };
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  await service.listOwned("slack:U123");
  failUpdate = true;
  await assert.rejects(() => service.deleteOwned("slack:U123", "apn_123"), /durable write failed/);
  assert.equal(
    requests.some((request) => request.method === "DELETE"),
    false,
  );
});

test("Pipedream deletion treats a missing provider account as already disconnected", async () => {
  const client = new PipedreamClient(
    {
      clientId: "client",
      clientSecret: "secret",
      projectId: "proj_test",
      environment: "development",
      externalIdSecret: "external-secret",
      apiUrl: "https://api.test",
    },
    async (input) =>
      String(input).endsWith("/v1/oauth/token")
        ? Response.json({ access_token: "pd_access", expires_in: 3600 })
        : Response.json({ error: "missing" }, { status: 404 }),
  );
  await client.deleteAccount("slack:U123", "apn_missing");
});

test("Pipedream rejects oversized responses before materializing them", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/v1/oauth/token")) {
      return new Response("x", { headers: { "content-length": "1000001" } });
    }
    return Response.json({});
  };
  const client = new PipedreamClient(
    {
      clientId: "client",
      clientSecret: "secret",
      projectId: "project",
      environment: "development",
      externalIdSecret: "external-secret",
    },
    fetchImpl,
  );
  await assert.rejects(() => client.listAccounts("slack:U123"), /size limit/);
});

test("Pipedream rejects plaintext direct endpoint overrides", () => {
  const base = {
    clientId: "client",
    clientSecret: "secret",
    projectId: "proj_test",
    environment: "development" as const,
    externalIdSecret: "external-secret",
  };
  assert.throws(() => new PipedreamClient({ ...base, apiUrl: "http://api.test" }), /HTTPS URL/);
  assert.throws(() => new PipedreamClient({ ...base, mcpUrl: "https://user:pass@mcp.test" }), /HTTPS URL/);
});

test("Pipedream account synchronization follows pagination and tolerates unnamed accounts", async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/v1/oauth/token")) return Response.json({ access_token: "pd_access", expires_in: 3600 });
    if (url.includes("after=next")) {
      return Response.json({
        data: [
          {
            id: "apn_2",
            name: null,
            healthy: true,
            dead: false,
            app: { name_slug: "hubspot", name: "HubSpot" },
            created_at: "",
            updated_at: "",
          },
        ],
        page_info: { count: 1, total_count: 2, end_cursor: "done" },
      });
    }
    return Response.json({
      data: [
        {
          id: "apn_1",
          name: "First",
          healthy: true,
          dead: false,
          app: { name_slug: "hubspot", name: "HubSpot" },
          created_at: "",
          updated_at: "",
        },
      ],
      page_info: { count: 1, total_count: 2, end_cursor: "next" },
    });
  };
  const client = new PipedreamClient(
    {
      clientId: "client",
      clientSecret: "secret",
      projectId: "proj_test",
      environment: "development",
      externalIdSecret: "external-secret",
    },
    fetchImpl,
  );
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  const accounts = await service.listOwned("slack:U123");
  assert.deepEqual(
    accounts.map((account) => [account.accountId, account.accountName]),
    [
      ["apn_1", "First"],
      ["apn_2", "HubSpot"],
    ],
  );
  assert.ok(requests.some((url) => url.includes("after=next")));
});

test("integration audit records policy deltas and call outcomes without arguments", async () => {
  const { client } = fixture();
  const store = createIntegrationConnectionStore(createMemoryMap());
  const audit = createAuditLog();
  const service = createPipedreamIntegrationService({
    client,
    store,
    audit,
    approvalSecret: "approval-secret",
    now: () => 123,
  });
  await service.listOwned("slack:U123");
  await assert.rejects(
    () =>
      service.call(
        "integrations",
        {
          action: "call_tool",
          account_id: "apn_123",
          tool: "create_contact",
          arguments: { api_key: "must-not-appear", email: "private@example.com" },
        },
        "slack:U123",
        "personal:slack:U123",
      ),
    /read-only/,
  );
  await service.updateOwned("slack:U123", "apn_123", { access: "read-write", scopes: ["channel:C123"] });
  await service.call(
    "integrations",
    { action: "call_tool", account_id: "apn_123", tool: "create_contact", arguments: { api_key: "secret" } },
    "slack:U123",
    "channel:C123",
  );
  const events = await audit.events();
  assert.deepEqual(
    events.map(({ action, resource, status }) => ({ action, resource, status })),
    [
      { action: "integration.tool.call", resource: "apn_123", status: "refused" },
      { action: "integration.policy.update", resource: "apn_123", status: "ok" },
      { action: "integration.tool.call", resource: "apn_123", status: "ok" },
    ],
  );
  assert.match(events[1]?.detail ?? "", /prior_access/);
  assert.match(events[1]?.detail ?? "", /channel:C123/);
  assert.ok(!JSON.stringify(events).includes("must-not-appear"));
  assert.ok(!JSON.stringify(events).includes("private@example.com"));
  assert.ok(!JSON.stringify(events).includes('"secret"'));
});
