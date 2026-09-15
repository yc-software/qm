import { test } from "node:test";
import assert from "node:assert/strict";
import { createComposioClient } from "../src/connectors/composio-client.ts";
import { createEnvSecretSource } from "../src/credentials/secret-source.ts";

const secret = "sentinel-project-secret";
const secrets = createEnvSecretSource({ COMPOSIO_API_KEY: secret });
const account = {
  id: "ca_test",
  user_id: "opaque-user",
  status: "ACTIVE",
  is_disabled: false,
  toolkit: { slug: "googlecalendar" },
  auth_config: { id: "ac_test", is_disabled: false },
  experimental: {
    account_type: "PRIVATE",
    acl_config_for_shared: { allow_all_users: false, allowed_user_ids: [], not_allowed_user_ids: [] },
  },
  state: { val: { access_token: "sentinel-provider-secret" } },
};

function clientWith(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return createComposioClient({
    secrets,
    fetchImpl: async (input, init) => handler(new URL(String(input)), init ?? {}),
  });
}

test("Composio discovers catalog entries without a per-app allowlist and keeps pagination", async () => {
  const client = clientWith((url, init) => {
    assert.equal(url.origin, "https://backend.composio.dev");
    assert.equal(url.pathname, "/api/v3.1/toolkits");
    assert.equal(url.searchParams.get("search"), "calendar & tasks");
    assert.equal(url.searchParams.get("cursor"), "next+page");
    assert.equal(new Headers(init.headers).get("x-api-key"), secret);
    assert.equal(init.redirect, "error");
    return Response.json({
      items: [
        {
          slug: "new_app",
          name: "New App",
          composio_managed_auth_schemes: ["OAUTH2"],
          meta: { description: "An app" },
          credentials: { token: secret },
        },
      ],
      next_cursor: "page-3",
    });
  });
  const page = await client.listToolkits({ search: "calendar & tasks", cursor: "next+page" });
  assert.equal(page.items[0]?.slug, "new_app");
  assert.equal(page.nextCursor, "page-3");
  assert.equal(JSON.stringify(page).includes(secret), false);
});

test("Composio checks configured secrets without putting the key in its public object", async () => {
  const client = createComposioClient({
    secrets: createEnvSecretSource({}),
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  assert.equal(await client.configured(), false);
  await assert.rejects(client.listToolkits(), /not configured/);
  assert.equal(JSON.stringify(createComposioClient({ secrets })).includes(secret), false);
});

test("Composio sessions enable the catalog without app mappings or remote workbench", async () => {
  const client = clientWith((url, init) => {
    assert.equal(url.pathname, "/api/v3.1/tool_router/session");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), {
      user_id: "opaque-user",
      manage_connections: { enable: false },
      workbench: { enable: false },
      multi_account: { enable: true, require_explicit_selection: true },
    });
    return Response.json({
      session_id: "ts_test",
      config: { user_id: "opaque-user" },
      mcp: { url: "https://secret.example.com/token" },
    });
  });
  assert.equal(await client.createSession("opaque-user"), "ts_test");
});

test("Composio connection links provision apps on demand, remain private and omit link tokens", async () => {
  const client = clientWith((url, init) => {
    assert.equal(url.pathname, "/api/v3.1/tool_router/session/ts_test/link");
    assert.deepEqual(JSON.parse(String(init.body)), {
      toolkit: "googlecalendar",
      experimental: { account_type: "PRIVATE" },
    });
    return Response.json({
      redirect_url: "https://connect.composio.dev/link",
      connected_account_id: "ca_test",
      link_token: "sentinel-link-token",
    });
  });
  const link = await client.authorizeSession("ts_test", "googlecalendar");
  assert.deepEqual(link, { connectedAccountId: "ca_test", redirectUrl: "https://connect.composio.dev/link" });
});

test("Composio verified completion posts the opaque session URI without fetching it", async () => {
  const client = clientWith((url, init) => {
    assert.equal(url.href, "https://backend.composio.dev/api/v3.1/connected_accounts/complete_auth");
    assert.deepEqual(JSON.parse(String(init.body)), {
      session_uri: "http://internal.invalid/opaque",
      user_id: "authenticated-returning-user",
    });
    return Response.json({ connected_account_id: "ca_test", toolkit_slug: "googlecalendar" });
  });
  assert.deepEqual(await client.completeAuth("http://internal.invalid/opaque", "authenticated-returning-user"), {
    connectedAccountId: "ca_test",
    toolkit: "googlecalendar",
  });
});

test("Composio account reads strip all provider token and connection payload fields", async () => {
  const client = clientWith(() => Response.json(account));
  const result = await client.getAccount("ca_test");
  assert.deepEqual(result, {
    id: "ca_test",
    userId: "opaque-user",
    toolkit: "googlecalendar",
    authConfigId: "ac_test",
    status: "ACTIVE",
    disabled: false,
    private: true,
  });
  assert.equal(JSON.stringify(result).includes("sentinel-provider-secret"), false);
});

test("Composio account isolation fails closed when sharing metadata is absent or broad", async () => {
  for (const experimental of [
    undefined,
    { account_type: "SHARED" },
    { account_type: "PRIVATE", acl_config_for_shared: { allow_all_users: true } },
    { account_type: "PRIVATE", acl_config_for_shared: { allowed_user_ids: ["other"] } },
  ]) {
    const client = clientWith(() => Response.json({ ...account, experimental }));
    assert.equal((await client.getAccount("ca_test")).private, false);
  }
});

test("Composio never forwards upstream error bodies or network error secrets", async () => {
  for (const status of [302, 401, 429, 500]) {
    const client = clientWith(() => new Response(secret, { status }));
    await assert.rejects(client.getAccount("ca_test"), (error: Error) => {
      assert.equal(String(error).includes(secret), false);
      assert.match(error.message, /Composio request failed/);
      return true;
    });
  }
  const client = clientWith(() => {
    throw new Error(secret);
  });
  await assert.rejects(client.getAccount("ca_test"), (error: Error) => !String(error).includes(secret));
});

test("Composio validates identifiers before issuing a request", async () => {
  let calls = 0;
  const client = clientWith(() => {
    calls++;
    return Response.json(account);
  });
  for (const id of ["", "..", "../auth_configs", "ca/a", "ca?x=1", "ca#x", "%2e%2e"]) {
    await assert.rejects(client.getAccount(id));
  }
  assert.equal(calls, 0);
});

test("Composio rejects malformed or oversized responses without repeating their payload", async () => {
  for (const response of [
    new Response(secret),
    Response.json({ items: secret }),
    new Response('"' + "x".repeat(2_100_000) + '"'),
  ]) {
    const client = clientWith(() => response);
    await assert.rejects(client.listToolkits(), (error: Error) => !String(error).includes(secret));
  }
});

test("Composio proxy always supplies an explicit account and omits caller-supplied auth overrides", async () => {
  const client = clientWith((_url, init) => {
    assert.deepEqual(JSON.parse(String(init.body)), {
      connected_account_id: "ca_test",
      endpoint: "https://www.googleapis.com/calendar/v3/calendars/primary",
      method: "GET",
      parameters: [{ name: "fields", value: "id", type: "query" }],
    });
    return Response.json({ status: 200, data: { id: "primary" }, headers: { "content-type": "application/json" } });
  });
  const result = await client.proxy("ca_test", {
    url: "https://www.googleapis.com/calendar/v3/calendars/primary",
    method: "GET",
    query: { fields: "id" },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { id: "primary" });
  await assert.rejects(client.proxy("", { url: "https://www.googleapis.com/", method: "GET" }));
  await assert.rejects(client.proxy("ca_test", { url: "http://www.googleapis.com/", method: "GET" }));
  await assert.rejects(client.proxy("ca_test", { url: "https://user:password@www.googleapis.com/", method: "GET" }));
});

test("Composio does not automatically retry uncertain writes", async () => {
  let calls = 0;
  const client = clientWith(() => {
    calls++;
    return new Response("unavailable", { status: 503 });
  });
  await assert.rejects(client.createSession("opaque-user"));
  assert.equal(calls, 1);
});

test("Composio preserves binary download references without fetching them", async () => {
  let calls = 0;
  const client = clientWith(() => {
    calls++;
    return Response.json({
      status: 200,
      data: null,
      headers: { "content-type": "application/pdf", "set-cookie": "secret-cookie", authorization: "secret-token" },
      binary_data: {
        url: "https://download.example.com/file",
        content_type: "application/pdf",
        size: 123,
        expires_at: "2030-01-01T00:00:00Z",
      },
    });
  });
  const result = await client.proxy("ca_test", {
    url: "https://www.googleapis.com/drive/v3/files/file/export",
    method: "GET",
  });
  assert.deepEqual(result.binaryData, {
    url: "https://download.example.com/file",
    contentType: "application/pdf",
    size: 123,
    expiresAt: "2030-01-01T00:00:00Z",
  });
  assert.deepEqual(result.headers, { "content-type": "application/pdf" });
  assert.equal(calls, 1);
});
