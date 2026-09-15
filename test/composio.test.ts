import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createComposioAdapter } from "../src/connectors/composio.ts";

const actor = { tenantId: "company-a", principalId: "person@example.com", scopeId: "personal:person@example.com" };
const binding = { tenantId: actor.tenantId, ownerId: actor.principalId, accountId: "ca_authorized", toolkit: "gmail" };
const tool = {
  slug: "GMAIL_SEND_EMAIL",
  name: "Send email",
  toolkit: { slug: "gmail", name: "Gmail" },
  version: "20260901_00",
  no_auth: false,
  input_parameters: { type: "object", properties: { recipient: { type: "string" }, body: { type: "string" } } },
};
const expectedUser = `qm_${createHash("sha256")
  .update(JSON.stringify([actor.tenantId, actor.principalId]))
  .digest("hex")}`;
const account = {
  id: binding.accountId,
  toolkit: { slug: "gmail" },
  status: "ACTIVE",
  status_reason: null,
  is_disabled: false,
  auth_config: { id: "ac_test", auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false },
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  experimental: { account_type: "PRIVATE" },
  data: { access_token: "provider-sentinel" },
};

type Authorize = Parameters<typeof createComposioAdapter>[0]["authorize"];
function fixture(authorize: Authorize = async () => binding) {
  const calls: Array<{
    url: URL;
    method: string;
    body: Record<string, unknown> | undefined;
    redirect: RequestInit["redirect"];
  }> = [];
  let toolResponse = structuredClone(tool);
  let accountResponse = structuredClone(account);
  let executeStatus = 200;
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, redirect: init?.redirect });
    assert.equal(url.origin, "https://backend.composio.dev");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "project-sentinel");
    if (url.pathname === "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL") {
      return Response.json(
        { data: { delivered: true, file: { url: "https://download.example/file" } }, error: null, successful: true },
        { status: executeStatus },
      );
    }
    if (url.pathname.startsWith("/api/v3.1/tools/")) return Response.json(toolResponse);
    if (url.pathname === "/api/v3.1/toolkits")
      return Response.json({ items: [{ slug: "new_app" }], next_cursor: "next-page" });
    if (url.pathname === "/api/v3.1/tools") return Response.json({ items: [toolResponse], next_cursor: null });
    if (url.pathname === "/api/v3.1/connected_accounts/complete_auth")
      return Response.json({ connected_account_id: binding.accountId, toolkit_slug: "gmail" });
    if (url.pathname.startsWith("/api/v3.1/connected_accounts/")) return Response.json(accountResponse);
    if (url.pathname === "/api/v3.1/tool_router/session")
      return Response.json({
        session_id: "ts_test",
        config: { user_id: expectedUser },
        tools: [],
        tool_router_tools: [],
        mcp: { type: "http", url: "https://mcp.example/secret" },
      });
    if (url.pathname === "/api/v3.1/tool_router/session/ts_test/link")
      return Response.json({
        connected_account_id: binding.accountId,
        redirect_url: "https://connect.composio.dev/link",
        link_token: "link-sentinel",
      });
    throw new Error(`Unexpected test endpoint: ${url.pathname}`);
  });
  const adapter = createComposioAdapter({ apiKey: "project-sentinel", authorize });
  return {
    adapter,
    calls,
    close: () => fetchMock.mock.restore(),
    setTool: (value: typeof tool) => {
      toolResponse = value;
    },
    setAccount: (value: typeof account) => {
      accountResponse = value;
    },
    setExecuteStatus: (value: number) => {
      executeStatus = value;
    },
  };
}

test("native SDK discovery retains provider tool schemas", async () => {
  const f = fixture();
  try {
    const tools = await f.adapter.discover("send email");
    assert.equal(tools[0]?.slug, tool.slug);
    assert.deepEqual(tools[0]?.inputParameters, tool.input_parameters);
    assert.equal(f.calls[0]?.url.searchParams.get("search"), "send email");
  } finally {
    f.close();
  }
});

test("native execution uses only the account returned by QM authorization", async () => {
  let authorizations = 0;
  const f = fixture(async (seenActor, operation) => {
    authorizations++;
    assert.deepEqual(seenActor, actor);
    assert.equal(operation.action, "execute");
    assert.equal(operation.connection, "local-handle");
    assert.equal(operation.tool?.version, tool.version);
    assert.deepEqual(operation.arguments, { recipient: "test@example.com", body: "hello" });
    return binding;
  });
  try {
    const result = await f.adapter.execute(
      actor,
      tool.slug,
      { recipient: "test@example.com", body: "hello" },
      "local-handle",
    );
    assert.equal(authorizations, 1);
    const dispatch = f.calls.find((call) => call.method === "POST")!;
    assert.equal(dispatch.body?.connected_account_id, binding.accountId);
    assert.equal(dispatch.body?.user_id, expectedUser);
    assert.equal(dispatch.body?.version, tool.version);
    assert.equal(dispatch.body?.custom_connection_data, undefined);
    assert.equal(dispatch.body?.custom_auth_params, undefined);
    assert.equal(dispatch.redirect, "error");
    assert.equal(result.successful, true);
    assert.deepEqual(result.data.file, { url: "https://download.example/file" });
  } finally {
    f.close();
  }
});

test("a policy denial prevents dispatch even for a native send tool", async () => {
  const f = fixture(async () => {
    throw new Error("approval required");
  });
  try {
    await assert.rejects(f.adapter.execute(actor, tool.slug, {}), /approval required/);
    assert.equal(
      f.calls.some((call) => call.method === "POST"),
      false,
    );
  } finally {
    f.close();
  }
});

test("missing, cross-company and mismatched toolkit grants fail closed", async () => {
  for (const value of [undefined, { ...binding, tenantId: "company-b" }, { ...binding, toolkit: "slack" }]) {
    const f = fixture(async () => value);
    try {
      await assert.rejects(f.adapter.execute(actor, tool.slug, {}));
      assert.equal(
        f.calls.some((call) => call.method === "POST"),
        false,
      );
    } finally {
      f.close();
    }
  }
});

test("provider data and policy callbacks cannot override selected account", async () => {
  const f = fixture(async (_actor, operation) => {
    operation.arguments!.connected_account_id = "ca_other";
    return binding;
  });
  try {
    await f.adapter.execute(actor, tool.slug, { connected_account_id: "ca_untrusted" });
    const body = f.calls.find((call) => call.method === "POST")!.body!;
    assert.equal(body.connected_account_id, binding.accountId);
    assert.deepEqual(body.arguments, { connected_account_id: "ca_untrusted" });
  } finally {
    f.close();
  }
});

test("meta execution and remote workbench entrypoints cannot bypass the single-operation gate", async () => {
  const f = fixture();
  try {
    for (const slug of [
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      "COMPOSIO_REMOTE_BASH_TOOL",
      "LOCAL_RUN",
      "CUSTOM_EXAMPLE_RUN",
      "../OTHER",
    ])
      await assert.rejects(f.adapter.execute(actor, slug, {}));
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test("no-auth tools still require policy authorization but no connection", async () => {
  let authorized = false;
  const f = fixture(async () => {
    authorized = true;
    return undefined;
  });
  f.setTool({ ...tool, no_auth: true });
  try {
    await f.adapter.execute(actor, tool.slug, {});
    assert.equal(authorized, true);
    assert.equal(f.calls.find((call) => call.method === "POST")?.body?.connected_account_id, undefined);
  } finally {
    f.close();
  }
});

test("SDK does not retry uncertain writes", async () => {
  const f = fixture();
  f.setExecuteStatus(503);
  try {
    await assert.rejects(f.adapter.execute(actor, tool.slug, {}));
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  } finally {
    f.close();
  }
});

test("status strips credential payloads and reports disabled accounts", async () => {
  const f = fixture();
  f.setAccount({ ...account, is_disabled: true });
  try {
    assert.deepEqual(await f.adapter.status(actor, "local-handle"), { status: "ACTIVE", needsReconnect: true });
  } finally {
    f.close();
  }
});

test("complete_auth is posted for the authenticated actor, never fetched as a URL", async () => {
  const f = fixture();
  try {
    const result = await f.adapter.complete(actor, "http://internal.invalid/opaque");
    assert.deepEqual(result, { accountId: binding.accountId, toolkit: "gmail" });
    assert.deepEqual(f.calls[0]?.body, { session_uri: "http://internal.invalid/opaque", user_id: expectedUser });
    assert.equal(f.calls[0]?.url.pathname, "/api/v3.1/connected_accounts/complete_auth");
  } finally {
    f.close();
  }
});

test("identities are namespaced by company", async () => {
  const f = fixture(async () => undefined);
  try {
    await f.adapter.complete(actor, "opaque-a");
    await f.adapter.complete({ ...actor, tenantId: "company-b" }, "opaque-b");
    const completions = f.calls.filter((call) => call.method === "POST");
    assert.equal(completions.length, 2);
    assert.notEqual(completions[0]?.body?.user_id, completions[1]?.body?.user_id);
  } finally {
    f.close();
  }
});

test("connect delegates automatic auth provisioning to native sessions", async () => {
  const f = fixture();
  try {
    const result = await f.adapter.connect(actor, "gmail");
    assert.deepEqual(result, { accountId: binding.accountId, connectUrl: "https://connect.composio.dev/link" });
    const creation = f.calls.find((call) => call.url.pathname === "/api/v3.1/tool_router/session")!;
    assert.equal(creation.body?.user_id, expectedUser);
    assert.deepEqual(creation.body?.manage_connections, { enable: false });
    assert.deepEqual(creation.body?.workbench, { enable: false });
    assert.equal(creation.body?.auth_configs, undefined);
  } finally {
    f.close();
  }
});

test("toolkit-scoped discovery uses the vendor filter rather than local app mappings", async () => {
  const f = fixture();
  try {
    await f.adapter.discover("send", "gmail");
    assert.equal(f.calls[0]?.url.searchParams.get("toolkit_slug"), "gmail");
  } finally {
    f.close();
  }
});

test("custom toolkit metadata cannot masquerade as a native tool", async () => {
  const f = fixture();
  f.setTool({ ...tool, toolkit: { slug: "custom_example", name: "Custom" } });
  try {
    await assert.rejects(f.adapter.execute(actor, tool.slug, {}), /native app tool/);
    assert.equal(
      f.calls.some((call) => call.method === "POST"),
      false,
    );
  } finally {
    f.close();
  }
});

test("denied disconnect and consent requests make no vendor calls", async () => {
  const f = fixture(async () => {
    throw new Error("not authorized");
  });
  try {
    await assert.rejects(f.adapter.disconnect(actor, "other-connection"), /not authorized/);
    await assert.rejects(f.adapter.connect(actor, "gmail"), /not authorized/);
    await assert.rejects(f.adapter.complete(actor, "opaque-session"), /not authorized/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.close();
  }
});

test("catalog preserves vendor pagination without a per-app registry", async () => {
  const f = fixture();
  try {
    const page = await f.adapter.catalog("previous-page");
    assert.equal(page.items[0]?.slug, "new_app");
    assert.equal(page.next_cursor, "next-page");
    assert.equal(f.calls[0]?.url.searchParams.get("cursor"), "previous-page");
  } finally {
    f.close();
  }
});
