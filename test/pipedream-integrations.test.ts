import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { commandApprovalId } from "../src/core/approval-id.ts";
import { createIntegrationConnectionStore } from "../src/integrations/integration-store.ts";
import { PipedreamClient } from "../src/integrations/pipedream-client.ts";
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
  await assert.rejects(
    () =>
      service.approvalFor!(
        "integrations",
        { action: "call_tool", account_id: "apn_123", tool: "find_contact" },
        "slack:U123",
        "personal:slack:U123",
      ),
    /read-only/,
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
  assert.match(writeApproval?.reason ?? "", /hubspot\/create_contact on account apn_123 with 0 argument fields/);
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

test("a provider read-only hint never bypasses local write policy or human approval", async () => {
  const { client } = fixture();
  const store = createIntegrationConnectionStore(createMemoryMap());
  const service = createPipedreamIntegrationService({ client, store, approvalSecret: "approval-secret" });
  await service.listOwned("slack:U123");
  await assert.rejects(
    () =>
      service.call(
        "integrations",
        { action: "call_tool", account_id: "apn_123", tool: "find_contact" },
        "slack:U123",
        "personal:slack:U123",
      ),
    /read-only/,
  );
  await service.updateOwned("slack:U123", "apn_123", { access: "read-write" });
  const approval = await service.approvalFor!(
    "integrations",
    { action: "call_tool", account_id: "apn_123", tool: "find_contact" },
    "slack:U123",
    "personal:slack:U123",
  );
  assert.match(approval?.approvalKey ?? "", /^integration:apn_123:find_contact:[0-9a-f]{24}$/);
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
  assert.ok(!approvalA?.reason.includes("a@example.com"));
  assert.ok(!approvalA?.reason.includes("sk_live_sensitive_key"));
  assert.match(approvalA?.reason ?? "", /with 3 argument fields/);
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
