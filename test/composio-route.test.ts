import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { composioRoutes, composioUserId } from "../src/api/routes/composio.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";
import { orgId } from "../src/config.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";

function fixture() {
  const keychain = createKeychain({
    lock: createMemoryAdvisoryLock(),
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("composio-test"),
  });
  const acl = createAclStore();
  const app = { getSessionForViewer: async (_id: string, _viewer: string): Promise<unknown> => null };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const replies: unknown[] = [];
  const audits: Array<{ action: string; resource?: string }> = [];
  const deps: Partial<ServerDeps> = {
    keychain,
    serviceCreds: keychain,
    acl,
    composioReturns: createMemoryMap(),
    auditLog: {
      record: (e: { action: string; resource?: string }) => audits.push(e),
    } as unknown as ServerDeps["auditLog"],
    runs: {
      get: async () => ({
        status: "running",
        sessionId: "cron:test-cron:fire:test-fire",
        attempts: 1,
        leaseToken: "test-lease",
        leaseExpiresAt: Date.now() + 60_000,
        request: { actor: { id: "alice" } },
      }),
    } as unknown as ServerDeps["runs"],
    composioFetch: (async (input, init) => {
      calls.push({ url: String(input), init });
      const result = replies.shift();
      if (result instanceof Error) throw result;
      if (result instanceof Response) return result;
      return Response.json(result);
    }) as typeof fetch,
  };
  async function invoke(
    path: string,
    body?: unknown,
    actor: string | null = "alice",
    capability?: CapabilityClaims,
    impersonating = false,
  ) {
    let status = 0;
    let text = "";
    const url = new URL(path, "http://localhost");
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        text = value;
      },
    } as unknown as ServerResponse;
    const ctx = {
      deps,
      app,
      res,
      url,
      body,
      capability,
      actor: actor ? { p: actor, exp: Date.now() + 60_000, ...(impersonating ? { imp: "admin" } : {}) } : null,
    } as ApiCtx;
    const route = composioRoutes.find((r) => "path" in r && r.path === url.pathname)!;
    await route.handle(ctx);
    return { status, data: JSON.parse(text), text };
  }
  async function own(ownerId = "alice", service = "composio") {
    await keychain.save({ ownerId, service, envKey: "COMPOSIO_API_KEY", secret: "private-key" });
  }
  async function shared(granted = true, enabled = true) {
    const org = scopeId("org", orgId());
    await keychain.setServiceCredential(org, {
      slug: "composio",
      name: "Composio",
      delivery: "env",
      envKey: "COMPOSIO_API_KEY",
      secret: "company-key",
      host: "",
      enabled,
    });
    if (granted)
      await acl.grant({
        ownerScopeId: org,
        ref: "service-cred:composio",
        granteeScopeId: org,
        permission: "read",
        grantedBy: "admin",
      });
  }
  return { invoke, own, shared, calls, replies, deps, app, audits };
}

test("Composio requires a verified actor and never uses another person's key", async () => {
  const f = fixture();
  await f.own("bob");
  assert.equal((await f.invoke("/v1/composio/toolkits", undefined, null)).status, 401);
  assert.equal((await f.invoke("/v1/composio/toolkits")).status, 403);
  assert.equal(f.calls.length, 0);
});

test("company credentials require an applicable grant and must be enabled", async () => {
  for (const [granted, enabled] of [
    [false, true],
    [true, false],
  ]) {
    const f = fixture();
    await f.shared(granted, enabled);
    assert.equal((await f.invoke("/v1/composio/toolkits")).status, 403);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await f.shared();
  f.replies.push({ items: [], next_cursor: null });
  assert.equal((await f.invoke("/v1/composio/toolkits")).status, 200);
  assert.equal(new Headers(f.calls[0]!.init?.headers).get("x-api-key"), "company-key");
});

test("catalog preserves provider usage order, pagination, and strips raw fields", async () => {
  const f = fixture();
  await f.own();
  f.replies.push({
    items: [
      { slug: "gmail", name: "Gmail", meta: { description: "Email" }, secret: "do-not-return" },
      { slug: "github", name: "GitHub" },
    ],
    next_cursor: "page+2",
  });
  const r = await f.invoke("/v1/composio/toolkits?cursor=page%2B1");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.data.items.map((x: { id: string }) => x.id),
    ["gmail", "github"],
  );
  assert.equal(r.data.nextCursor, "page+2");
  assert.doesNotMatch(r.text, /private-key|do-not-return/);
  const url = new URL(f.calls[0]!.url);
  assert.equal(url.searchParams.get("sort_by"), "usage");
  assert.equal(url.searchParams.get("cursor"), "page+1");
});

test("ambiguous personal keys fail closed rather than switching to the company key", async () => {
  const f = fixture();
  await f.own();
  await f.own("alice", "another-project");
  await f.shared();
  assert.equal((await f.invoke("/v1/composio/toolkits")).status, 409);
  assert.equal(f.calls.length, 0);
});

test("authorization binds the session to the authenticated actor, ignoring supplied identity", async () => {
  for (const link of ["https://connect.composio.dev/link/lk_test", "https://app.composio.dev/link/lt_test"]) {
    const f = fixture();
    await f.own();
    f.replies.push(
      { session_id: "trs_test" },
      { redirect_url: link, connected_account_id: "ca_test", secret: "hidden" },
    );
    const r = await f.invoke("/v1/composio/authorize", { toolkit: "gmail", user_id: "bob", principalId: "bob" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { url: link, accountId: "ca_test" });
    const payload = JSON.parse(String(f.calls[0]!.init?.body));
    assert.equal(payload.user_id, composioUserId(orgId(), "alice"));
    assert.deepEqual(payload.toolkits, { enable: ["gmail"] });
    assert.deepEqual(payload.manage_connections, { enable: false });
    assert.equal(f.calls[1]!.url.endsWith("/tool_router/session/trs_test/link"), true);
  }
});

test("invalid toolkits and unsafe authorization destinations are rejected", async () => {
  const f = fixture();
  await f.own();
  assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "../../anything" })).status, 400);
  assert.equal(f.calls.length, 0);
  for (const redirect_url of [
    "https://evil.example/link/lk_test",
    "https://connect.composio.dev.evil.example/link/lk_test",
    "https://user:pass@connect.composio.dev/link/lk_test",
    "http://connect.composio.dev/link/lk_test",
    "https://connect.composio.dev/other",
  ]) {
    f.replies.push({ session_id: "trs_test" }, { redirect_url, connected_account_id: "ca_test" });
    assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail" })).status, 502);
  }
});

test("upstream errors are redacted and identity is stable per organization and person", async () => {
  const f = fixture();
  await f.own();
  f.replies.push(new Error("private-key"));
  const r = await f.invoke("/v1/composio/toolkits");
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.text, /private-key/);
  assert.notEqual(composioUserId("a", "alice"), composioUserId("b", "alice"));
  assert.notEqual(composioUserId("a", "alice"), composioUserId("a", "bob"));
  assert.deepEqual((await f.invoke("/v1/composio/identity")).data, {
    userId: composioUserId(orgId(), "alice"),
    userIds: [composioUserId(orgId(), "alice")],
  });
});

test("authorization supplies the callback and account binding without accepting unsafe callback schemes", async () => {
  const f = fixture();
  await f.own();
  for (const callbackUrl of ["javascript:alert(1)", "http://evil.example/", "https://user:password@example.com/"]) {
    assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail", callbackUrl })).status, 400);
  }
  assert.equal(f.calls.length, 0);
  const callbackUrl = "https://qm.example/s/chat?composioReturn=nonce";
  f.replies.push(
    { session_id: "trs_test" },
    { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test" },
  );
  const r = await f.invoke("/v1/composio/authorize", { toolkit: "gmail", callbackUrl });
  assert.equal(r.data.accountId, "ca_test");
  assert.equal(JSON.parse(String(f.calls[1]!.init?.body)).callback_url, callbackUrl);
});

test("connections return only this actor's active accounts and strip credentials", async () => {
  const f = fixture();
  await f.own();
  const owned = {
    id: "ca_gmail",
    user_id: composioUserId(orgId(), "alice"),
    status: "ACTIVE",
    toolkit: { slug: "gmail" },
    data: { token: "secret-token" },
  };
  f.replies.push({
    items: [
      owned,
      { ...owned, id: "ca_other", user_id: composioUserId(orgId(), "bob") },
      { ...owned, status: "INITIATED" },
      { ...owned, is_disabled: true },
    ],
    next_cursor: "next-page",
  });
  const r = await f.invoke("/v1/composio/connections?user_ids=bob&cursor=page-1");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, {
    items: [{ id: "ca_gmail", toolkit: "gmail", userId: composioUserId(orgId(), "alice"), missingScopes: [] }],
    nextCursor: "next-page",
  });
  const q = new URL(f.calls[0]!.url).searchParams;
  assert.equal(q.get("user_ids"), composioUserId(orgId(), "alice"));
  assert.equal(q.get("statuses"), "ACTIVE");
  assert.equal(q.get("cursor"), "page-1");
  assert.doesNotMatch(r.text, /secret-token|private-key|user_id/);
});

test("connections report scopes the app's configuration grants that an older connection lacks", async () => {
  const f = fixture();
  await f.own();
  const account = (id: string, scope: string | undefined, config = "ac_x") => ({
    id,
    user_id: composioUserId(orgId(), "alice"),
    status: "ACTIVE",
    toolkit: { slug: "twitter" },
    auth_config: { id: config },
    state: { authScheme: "OAUTH2", val: { scope, access_token: "secret-token" } },
  });
  f.replies.push(
    {
      items: [
        account("ca_old", "tweet.read users.read offline.access"),
        account("ca_new", "tweet.read users.read offline.access dm.read dm.write"),
        account("ca_unknown", undefined),
        account("ca_unreadable", "tweet.read", "ac_gone"),
      ],
    },
    {
      credentials: {
        scopes: ["tweet.read", "users.read", "offline.access", "dm.read", "dm.write"],
        client_secret: "s3",
      },
    },
    new Response("missing", { status: 404 }),
  );
  const r = await f.invoke("/v1/composio/connections");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.data.items.map((item: { id: string; missingScopes: string[] }) => [item.id, item.missingScopes]),
    [
      ["ca_old", ["dm.read", "dm.write"]],
      ["ca_new", []],
      ["ca_unknown", []],
      ["ca_unreadable", []],
    ],
  );
  assert.deepEqual(
    f.calls.slice(1).map((call) => new URL(call.url).pathname),
    ["/api/v3.1/auth_configs/ac_x", "/api/v3.1/auth_configs/ac_gone"],
  );
  assert.doesNotMatch(r.text, /secret-token|s3|private-key/);
  f.replies.push({ items: [account("ca_old", "tweet.read"), account("ca_unreadable", "tweet.read", "ac_gone")] }, {});
  await f.invoke("/v1/composio/connections");
  assert.deepEqual(
    f.calls.slice(3).map((call) => new URL(call.url).pathname),
    ["/api/v3.1/connected_accounts", "/api/v3.1/auth_configs/ac_gone"],
  );
});

test("scopes granted in URL form match their short configured names", async () => {
  const f = fixture();
  await f.own();
  f.replies.push(
    {
      items: [
        {
          id: "ca_outlook",
          user_id: composioUserId(orgId(), "alice"),
          status: "ACTIVE",
          toolkit: { slug: "outlook" },
          auth_config: { id: "ac_outlook" },
          state: { val: { scope: "https://graph.microsoft.com/Mail.Read offline_access https://mail.google.com/" } },
        },
      ],
    },
    { credentials: { scopes: ["Mail.Read", "offline_access", "https://mail.google.com/", "Mail.Send"] } },
  );
  const r = await f.invoke("/v1/composio/connections");
  assert.deepEqual(r.data.items[0].missingScopes, ["Mail.Send"]);
});

test("people can disconnect only their own connections, on a turn they started", async () => {
  const f = fixture();
  await f.own();
  const mine = {
    id: "ca_mine",
    user_id: composioUserId(orgId(), "alice"),
    status: "EXPIRED",
    toolkit: { slug: "twitter" },
  };
  f.replies.push(mine, {});
  const r = await f.invoke("/v1/composio/disconnect", { accountId: "ca_mine" });
  assert.deepEqual([r.status, r.data], [200, { disconnected: "ca_mine", toolkit: "twitter" }]);
  assert.deepEqual(
    f.calls.map((call) => [call.init?.method, new URL(call.url).pathname]),
    [
      ["GET", "/api/v3.1/connected_accounts/ca_mine"],
      ["DELETE", "/api/v3.1/connected_accounts/ca_mine"],
    ],
  );
  assert.deepEqual(
    f.audits.filter((e) => e.action === "composio.disconnected").map((e) => e.resource),
    ["twitter/ca_mine"],
  );

  f.replies.push(mine, {});
  assert.equal((await f.invoke("/v1/composio/disconnect", { accountId: "ca_mine" }, null, privateCap)).status, 200);

  for (const account of [
    { ...mine, user_id: composioUserId(orgId(), "bob") },
    { ...mine, id: "ca_other" },
    { ...mine, toolkit: { slug: "composio" } },
  ]) {
    const g = fixture();
    await g.own();
    g.replies.push(account);
    assert.equal((await g.invoke("/v1/composio/disconnect", { accountId: "ca_mine" })).status, 403);
    assert.ok(g.calls.every((call) => call.init?.method === "GET"));
  }

  const g = fixture();
  await g.own();
  g.replies.push(new Response("gone", { status: 404 }));
  assert.equal((await g.invoke("/v1/composio/disconnect", { accountId: "ca_mine" })).status, 404);
});

test("disconnecting refuses automations, impersonation and malformed accounts before provider calls", async () => {
  for (const [body, actor, capability, impersonating, status] of [
    [{ accountId: "ca_mine" }, null, { ...privateCap, liveActor: false, triggered: true }, false, 403],
    [{ accountId: "ca_mine" }, "alice", undefined, true, 403],
    [{ accountId: "../ca_mine" }, "alice", undefined, false, 400],
    [{ accountId: "ca_mine" }, null, undefined, false, 401],
  ] as const) {
    const f = fixture();
    await f.own();
    assert.equal((await f.invoke("/v1/composio/disconnect", body, actor, capability, impersonating)).status, status);
    assert.equal(f.calls.length, 0);
  }
});

test("connections require credential access and fail visibly on upstream errors", async () => {
  const f = fixture();
  assert.equal((await f.invoke("/v1/composio/connections", undefined, null)).status, 401);
  assert.equal((await f.invoke("/v1/composio/connections")).status, 403);
  await f.own();
  f.replies.push(new Error("private-key"));
  const r = await f.invoke("/v1/composio/connections");
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.text, /private-key/);
});

test("Slack connection links verified workspace identity to the web owner and persists status", async () => {
  const f = fixture();
  await f.own();
  const { createPrincipalLinkService } = await import("../src/identity/principal-links.ts");
  const { createDirectoryStore } = await import("../src/directory/directory-store.ts");
  const { installPrincipalLinks, canonicalPerson } = await import("../src/directory/person.ts");
  f.deps.principalLinks = createPrincipalLinkService();
  installPrincipalLinks(f.deps.principalLinks);
  f.deps.slackAccounts = createMemoryMap();
  f.deps.signingSecret = "qa-slack-link-secret";
  f.deps.directory = createDirectoryStore();
  await f.deps.directory.replace([
    { principalId: "work@example.test", slackId: "U123", displayName: "Alice", type: "internal" },
  ]);
  f.deps.slackEnvBotToken = "bot-test";
  f.deps.slackInstallationFetch = (async () => Response.json({ ok: true, team_id: "T123" })) as typeof fetch;
  try {
    f.replies.push(
      { session_id: "trs_test" },
      { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test" },
    );
    const started = await f.invoke("/v1/composio/slack/authorize", {});
    assert.equal(started.status, 200);
    const account = {
      id: "ca_test",
      user_id: composioUserId(orgId(), "alice"),
      toolkit: { slug: "slack" },
      status: "ACTIVE",
    };
    f.replies.push(account, { data: { ok: true, user_id: "U123", team_id: "T123", user: "alice", team: "Acme" } });
    f.replies.push({ items: [] });
    const linked = await f.invoke("/v1/composio/slack/complete", { ticket: started.data.ticket });
    assert.equal(linked.status, 200);
    assert.equal(canonicalPerson("work@example.test"), "alice");
    assert.equal((await f.deps.slackAccounts.get("alice"))?.accountId, "ca_test");
    f.replies.push(account);
    assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
    f.replies.push({ ...account, status: "REVOKED" });
    assert.equal((await f.invoke("/v1/composio/slack")).data.connected, false);
    f.replies.push(account, { data: { ok: true, user_id: "U123", team_id: "T123", user: "alice", team: "Acme" } });
    assert.equal((await f.invoke("/v1/composio/slack/complete", { ticket: started.data.ticket })).status, 200);
  } finally {
    installPrincipalLinks(null);
  }
});

test("Slack link rejects changed browser accounts, wrong owner, bots, other workspaces and inactive connections", async () => {
  const { createPrincipalLinkService } = await import("../src/identity/principal-links.ts");
  const { createDirectoryStore } = await import("../src/directory/directory-store.ts");
  const { mintSignedPayload } = await import("../src/auth/signed-token.ts");
  for (const scenario of [
    "expired",
    "other-browser",
    "wrong-owner",
    "bot",
    "wrong-workspace",
    "pending",
    "existing-connectors",
    "existing-key",
    "different-project",
  ]) {
    const f = fixture();
    await f.own();
    await f.own("bob");
    f.deps.signingSecret = "slack-test";
    f.deps.principalLinks = createPrincipalLinkService();
    f.deps.slackAccounts = createMemoryMap();
    f.deps.directory = createDirectoryStore();
    await f.deps.directory.replace([
      { principalId: "work@example.test", slackId: "U123", displayName: "Alice", type: "internal" },
    ]);
    f.deps.slackEnvBotToken = "bot-test";
    f.deps.slackInstallationFetch = (async () => Response.json({ ok: true, team_id: "T123" })) as typeof fetch;
    const ticket = await mintSignedPayload(
      {
        purpose: "slack-account-link",
        principal: "alice",
        org: orgId(),
        accountId: "ca_test",
        exp: Date.now() + (scenario === "expired" ? -1000 : 60000),
      },
      "slack-test",
    );
    f.replies.push(
      {
        id: "ca_test",
        user_id: composioUserId(orgId(), scenario === "wrong-owner" ? "bob" : "alice"),
        toolkit: { slug: "slack" },
        status: scenario === "pending" ? "INITIATED" : "ACTIVE",
      },
      {
        data: {
          ok: true,
          user_id: "U123",
          team_id: scenario === "wrong-workspace" ? "T999" : "T123",
          ...(scenario === "bot" ? { bot_id: "B123" } : {}),
        },
      },
    );
    if (scenario === "existing-key") await f.own("work@example.test");
    if (scenario === "different-project") await f.shared();
    f.replies.push({ items: scenario === "existing-connectors" ? [{ id: "ca_existing" }] : [] });
    if (scenario === "different-project") f.replies.push({ items: [{ id: "ca_company_existing" }] });
    const result = await f.invoke(
      "/v1/composio/slack/complete",
      { ticket },
      scenario === "other-browser" ? "bob" : "alice",
    );
    assert.ok(result.status >= 400, `${scenario}: ${result.status}`);
    assert.equal((await f.deps.principalLinks.list()).length, 0);
    assert.equal((await f.deps.slackAccounts.all()).length, 0);
  }
});

const privateCap: CapabilityClaims = {
  runId: "test-run",
  sessionId: "test-session",
  threadRef: "cron:test-cron:fire:test-fire",
  runAttempt: 1,
  runLeaseToken: "test-lease",
  actorId: "alice",
  scopeId: "personal:alice",
  ownerConnections: true,
  liveActor: true,
  exp: Date.now() + 60_000,
};
const execution = {
  tool: "GMAIL_FETCH_EMAILS",
  accountId: "ca_alice",
  version: "20260901_00",
  arguments: { max_results: 1 },
};
const aliceAccount = {
  id: "ca_alice",
  user_id: composioUserId(orgId(), "alice"),
  status: "ACTIVE",
  toolkit: { slug: "gmail" },
};
const gmailTool = { slug: execution.tool, version: execution.version, toolkit: { slug: "gmail" } };

test("backend execution binds user and account, pins tool version, and withholds raw response metadata", async () => {
  const f = fixture();
  await f.shared();
  f.replies.push(aliceAccount, gmailTool, {
    data: { emails: [] },
    successful: true,
    session_info: { secret: "hidden" },
  });
  const result = await f.invoke("/v1/composio/execute", execution, null, privateCap);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { data: { emails: [] }, successful: true, error: null });
  assert.deepEqual(JSON.parse(f.calls[2]!.init!.body as string), {
    user_id: composioUserId(orgId(), "alice"),
    connected_account_id: "ca_alice",
    version: execution.version,
    arguments: execution.arguments,
  });
  assert.doesNotMatch(result.text, /company-key|hidden/);
});

test("execution rejects other owners, inactive accounts, disabled accounts, and mismatched toolkits", async () => {
  for (const account of [
    { ...aliceAccount, user_id: composioUserId(orgId(), "bob") },
    { ...aliceAccount, id: "ca_bob" },
    { ...aliceAccount, status: "EXPIRED" },
    { ...aliceAccount, is_disabled: true },
    { ...aliceAccount, toolkit: { slug: "github" } },
  ]) {
    const f = fixture();
    await f.own();
    f.replies.push(account, gmailTool);
    assert.equal((await f.invoke("/v1/composio/execute", execution, null, privateCap)).status, 403);
    assert.ok(f.calls.every((call) => call.init?.method !== "POST"));
  }
});

test("agent cannot override identity, credentials, proxy parameters or use meta tools", async () => {
  for (const patch of [
    { user_id: "bob" },
    { custom_auth_params: {} },
    { tool: "COMPOSIO_MULTI_EXECUTE_TOOL" },
    { tool: "../proxy" },
    { version: "latest" },
  ]) {
    const f = fixture();
    await f.own();
    assert.equal((await f.invoke("/v1/composio/execute", { ...execution, ...patch }, null, privateCap)).status, 400);
    assert.equal(f.calls.length, 0);
  }
});

test("capabilities without owner authorization, deployments and closed shared scopes fail before provider calls", async () => {
  for (const cap of [
    { ...privateCap, ownerConnections: undefined },
    { ...privateCap, deployment: "app" },
    { ...privateCap, botActor: true },
    { ...privateCap, scopeId: "channel:general" },
  ]) {
    const f = fixture();
    await f.own();
    assert.equal((await f.invoke("/v1/composio/connections", undefined, null, cap)).status, 403);
    assert.equal(f.calls.length, 0);
  }
});

test("authorized personal automation may execute but cannot initiate consent", async () => {
  const f = fixture();
  await f.own();
  const cap = { ...privateCap, liveActor: false, triggered: true };
  assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail" }, null, cap)).status, 403);
  f.replies.push(aliceAccount, gmailTool, { successful: true, data: {} });
  assert.equal((await f.invoke("/v1/composio/execute", execution, null, cap)).status, 200);
});

test("cron discovery accepts a current capability with distinct thread and session identifiers", async () => {
  const f = fixture();
  await f.own();
  f.replies.push({ items: [{ slug: "googlecalendar", name: "Google Calendar" }] });
  const cap = { ...privateCap, liveActor: false, triggered: true };
  const result = await f.invoke("/v1/composio/toolkits", undefined, null, cap);
  assert.equal(result.status, 200);
  assert.equal(result.data.items[0].id, "googlecalendar");
  assert.equal(f.calls.length, 1);
});

test("execution never retries a provider failure", async () => {
  const f = fixture();
  await f.own();
  f.replies.push(aliceAccount, gmailTool, new Error("uncertain write"));
  assert.equal((await f.invoke("/v1/composio/execute", execution, null, privateCap)).status, 502);
  assert.equal(f.calls.length, 3);
});

test("execution failures tell the agent whether the tool timed out", async () => {
  const f = fixture();
  await f.own();
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  f.replies.push(aliceAccount, gmailTool, timeout);
  const result = await f.invoke("/v1/composio/execute", execution, null, privateCap);
  assert.equal(result.status, 502);
  assert.equal(result.data.cause, "timeout");
  assert.match(result.data.message, /smaller pages/);
});

test("oversized provider responses are reported with their status", async () => {
  const f = fixture();
  await f.own();
  f.replies.push(aliceAccount, gmailTool, new Response("payload too large", { status: 413 }));
  const result = await f.invoke("/v1/composio/execute", execution, null, privateCap);
  assert.equal(result.status, 502);
  assert.equal(result.data.cause, "provider_error");
  assert.equal(result.data.providerStatus, 413);
  assert.match(result.data.message, /smaller pages/);
});

test("callback completion is browser-only and preserves the durable return URL", async () => {
  const f = fixture();
  await f.own();
  assert.equal((await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque" }, null, privateCap)).status, 403);
  const url = "https://qm.example/s/chat?composioReturn=state";
  f.replies.push(
    { session_id: "trs_example" },
    { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test" },
  );
  assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail", callbackUrl: url })).status, 200);
  f.replies.push({ connected_account_id: "ca_test", toolkit_slug: "gmail" });
  assert.deepEqual((await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque", user_id: "bob" })).data, {
    returnTo: url,
  });
  assert.deepEqual(JSON.parse(f.calls[2]!.init!.body as string), {
    session_uri: "opaque",
    user_id: composioUserId(orgId(), "alice"),
  });
  assert.equal((await f.deps.composioReturns!.entries()).length, 0);
  assert.deepEqual(
    f.audits.filter((e) => e.action.startsWith("composio.conn")).map((e) => [e.action, e.resource]),
    [["composio.connected", "gmail"]],
  );
});

test("connects without a return page are still audited on completion, and failed completions too", async () => {
  const f = fixture();
  await f.own();
  f.replies.push(
    { session_id: "trs_example" },
    { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test" },
  );
  assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "outlook" })).status, 200);
  f.replies.push({ connected_account_id: "ca_test" });
  assert.deepEqual((await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque" })).data, { returnTo: null });
  f.replies.push(new Response("bad", { status: 400 }));
  assert.equal((await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque" })).status, 400);
  assert.equal((await f.invoke("/v1/composio/complete-auth", { sessionUri: null })).status, 400);
  assert.deepEqual(
    f.audits.filter((e) => e.action.startsWith("composio.conn")).map((e) => [e.action, e.resource]),
    [
      ["composio.connected", "outlook"],
      ["composio.connect_failed", "unknown"],
      ["composio.connect_failed", "unknown"],
    ],
  );
});

test("finished runs and stale lease capabilities cannot reuse backend connection access", async () => {
  for (const patch of [
    { runId: undefined },
    { runLeaseToken: "stale" },
    { runAttempt: 2 },
    { threadRef: undefined },
    { threadRef: "another" },
  ]) {
    const f = fixture();
    await f.own();
    assert.equal((await f.invoke("/v1/composio/execute", execution, null, { ...privateCap, ...patch })).status, 403);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await f.own();
  f.deps.runs = { get: async () => ({ status: "done" }) } as unknown as ServerDeps["runs"];
  assert.equal((await f.invoke("/v1/composio/connections", undefined, null, privateCap)).status, 403);
  assert.equal(f.calls.length, 0);
});

test("ending the run during account lookup prevents execution", async () => {
  const f = fixture();
  await f.own();
  const original = f.deps.composioFetch!;
  f.deps.composioFetch = async (...args) => {
    const response = await original(...args);
    f.deps.runs = { get: async () => ({ status: "done" }) } as unknown as ServerDeps["runs"];
    return response;
  };
  f.replies.push(aliceAccount, gmailTool);
  assert.equal((await f.invoke("/v1/composio/execute", execution, null, privateCap)).status, 403);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.init?.method === "GET"));
});

test("ending the run during account lookup prevents disconnecting", async () => {
  const f = fixture();
  await f.own();
  const original = f.deps.composioFetch!;
  f.deps.composioFetch = async (...args) => {
    const response = await original(...args);
    f.deps.runs = { get: async () => ({ status: "done" }) } as unknown as ServerDeps["runs"];
    return response;
  };
  f.replies.push(aliceAccount);
  assert.equal((await f.invoke("/v1/composio/disconnect", { accountId: "ca_alice" }, null, privateCap)).status, 403);
  assert.deepEqual(
    f.calls.map((call) => call.init?.method),
    ["GET"],
  );
});

test("shared org connections recheck grants for every audience member", async () => {
  const f = fixture();
  await f.shared(false);
  const org = scopeId("org", orgId());
  await f.deps.acl!.grant({
    ownerScopeId: org,
    ref: "service-cred:composio",
    granteeScopeId: "personal:alice",
    permission: "read",
    grantedBy: "admin",
  });
  const cap = {
    ...privateCap,
    scopeId: "channel:C1",
    liveActor: false,
    triggered: true,
    keychainMembers: [
      { id: "alice", type: "internal" as const },
      { id: "bob", type: "internal" as const },
    ],
  };
  assert.equal((await f.invoke("/v1/composio/connections", undefined, null, cap)).status, 403);
  assert.equal(f.calls.length, 0);
  await f.shared();
  f.replies.push({ items: [] });
  assert.equal((await f.invoke("/v1/composio/connections", undefined, null, cap)).status, 200);
});

test("expired callback returns are discarded after successful browser verification", async () => {
  const f = fixture();
  await f.own();
  const key = `${composioUserId(orgId(), "alice")}:ca_test`;
  await f.deps.composioReturns!.put(key, {
    url: "https://qm.example/old",
    toolkit: "gmail",
    expiresAt: Date.now() - 1,
  });
  f.replies.push({ connected_account_id: "ca_test" });
  assert.deepEqual((await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque" })).data, { returnTo: null });
  assert.equal(await f.deps.composioReturns!.get(key), null);
});

test("linked aliases can execute their existing accounts until the identity link is removed", async () => {
  const { createPrincipalLinkService } = await import("../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  const links = createPrincipalLinkService();
  installPrincipalLinks(links);
  const aliasId = "oidc:alice";
  const aliasUserId = composioUserId(orgId(), aliasId);
  const account = { ...aliceAccount, user_id: aliasUserId };
  try {
    await links.link({ principalId: aliasId, canonicalId: "alice", evidence: "test", linkedBy: "admin" });
    for (const actorId of ["alice", aliasId]) {
      f.replies.push(account, gmailTool, { successful: true, data: { emails: [] } });
      const cap = { ...privateCap, actorId, scopeId: scopeId("personal", actorId) };
      assert.equal((await f.invoke("/v1/composio/execute", execution, null, cap)).status, 200);
      assert.deepEqual(JSON.parse(String(f.calls.at(-1)!.init?.body)), {
        user_id: aliasUserId,
        connected_account_id: account.id,
        version: execution.version,
        arguments: execution.arguments,
      });
    }
    await links.unlink(aliasId);
    const before = f.calls.length;
    f.replies.push(account);
    const revoked = await f.invoke("/v1/composio/execute", execution, null, privateCap);
    assert.equal(revoked.status, 403);
    assert.equal(revoked.data.error, "connection_not_authorized");
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.calls.at(-1)!.init?.method, "GET");
  } finally {
    installPrincipalLinks(null);
  }
});

test("linked account discovery and Slack status preserve historical aliases without exposing other owners", async () => {
  const { createPrincipalLinkService } = await import("../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  const links = createPrincipalLinkService();
  f.deps.principalLinks = links;
  f.deps.slackAccounts = createMemoryMap();
  installPrincipalLinks(links);
  const aliasId = "oidc:alice";
  const canonicalUserId = composioUserId(orgId(), "alice");
  const aliasUserId = composioUserId(orgId(), aliasId);
  const account = { id: "ca_legacy", user_id: aliasUserId, status: "ACTIVE", toolkit: { slug: "slack" } };
  await f.deps.slackAccounts.put(aliasId, {
    principalId: aliasId,
    memberId: "alice",
    accountId: account.id,
    userId: "U123",
    teamId: "T123",
    user: "Alice",
    workspace: "Example",
  });
  try {
    await links.link({ principalId: aliasId, canonicalId: "alice", evidence: "test", linkedBy: "admin" });
    f.replies.push({
      items: [
        account,
        { ...account, id: "ca_current", user_id: canonicalUserId },
        { ...account, id: "ca_other", user_id: composioUserId(orgId(), "bob") },
        { ...account, id: "ca_other_org", user_id: composioUserId("other-org", aliasId) },
      ],
      next_cursor: "next",
    });
    const listed = await f.invoke("/v1/composio/connections?cursor=page");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.items, [
      { id: "ca_legacy", toolkit: "slack", userId: composioUserId(orgId(), aliasId), missingScopes: [] },
      { id: "ca_current", toolkit: "slack", userId: composioUserId(orgId(), "alice"), missingScopes: [] },
    ]);
    assert.equal(listed.data.nextCursor, "next");
    const query = new URL(f.calls.at(-1)!.url).searchParams;
    assert.equal(query.get("user_ids"), [canonicalUserId, aliasUserId].join(","));
    assert.equal(query.get("cursor"), "page");
    f.replies.push(account);
    assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
    await links.unlink(aliasId);
    f.replies.push({ items: [account] });
    assert.deepEqual((await f.invoke("/v1/composio/connections")).data.items, []);
    const before = f.calls.length;
    assert.equal((await f.invoke("/v1/composio/slack")).data.connected, false);
    assert.equal(f.calls.length, before);
  } finally {
    installPrincipalLinks(null);
  }
});

test("unlinking an account owner during tool lookup prevents provider execution", async () => {
  const { createPrincipalLinkService } = await import("../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  const links = createPrincipalLinkService();
  installPrincipalLinks(links);
  const aliasId = "oidc:alice";
  try {
    await links.link({ principalId: aliasId, canonicalId: "alice", evidence: "test", linkedBy: "admin" });
    const original = f.deps.composioFetch!;
    f.deps.composioFetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes(`/tools/${execution.tool}?`)) await links.unlink(aliasId);
      return response;
    };
    f.replies.push({ ...aliceAccount, user_id: composioUserId(orgId(), aliasId) }, gmailTool);
    const result = await f.invoke("/v1/composio/execute", execution, null, privateCap);
    assert.equal(result.status, 403);
    assert.equal(result.data.error, "connection_not_authorized");
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every((call) => call.init?.method === "GET"));
  } finally {
    installPrincipalLinks(null);
  }
});

test("consent and browser verification use the canonical identity when signed in through an alias", async () => {
  const { createPrincipalLinkService } = await import("../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  const links = createPrincipalLinkService();
  installPrincipalLinks(links);
  const aliasId = "oidc:alice";
  const userId = composioUserId(orgId(), "alice");
  const callbackUrl = "https://qm.example/s/chat?composioReturn=linked";
  try {
    await links.link({ principalId: aliasId, canonicalId: "alice", evidence: "test", linkedBy: "admin" });
    f.replies.push(
      { session_id: "trs_linked" },
      { redirect_url: "https://connect.composio.dev/link/lk_linked", connected_account_id: "ca_linked" },
    );
    assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail", callbackUrl }, aliasId)).status, 200);
    assert.equal(JSON.parse(String(f.calls[0]!.init?.body)).user_id, userId);
    assert.equal((await f.deps.composioReturns!.get(`${userId}:ca_linked`))?.url, callbackUrl);
    f.replies.push({ connected_account_id: "ca_linked", toolkit_slug: "gmail" });
    const result = await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque" }, aliasId);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { returnTo: callbackUrl });
    assert.deepEqual(JSON.parse(String(f.calls.at(-1)!.init?.body)), { session_uri: "opaque", user_id: userId });
    assert.equal((await f.deps.composioReturns!.entries()).length, 0);
  } finally {
    installPrincipalLinks(null);
  }
});

test("linked identities retain provider accounts and Slack status until unlinked", async () => {
  const { createPrincipalLinkService } = await import("../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  f.deps.principalLinks = createPrincipalLinkService();
  f.deps.slackAccounts = createMemoryMap();
  installPrincipalLinks(f.deps.principalLinks);
  const canonical = composioUserId(orgId(), "alice");
  const alias = composioUserId(orgId(), "oidc:alice");
  const account = { id: "ca_old", user_id: alias, status: "ACTIVE", toolkit: { slug: "slack" } };
  await f.deps.slackAccounts.put("oidc:alice", {
    principalId: "oidc:alice",
    memberId: "alice",
    accountId: "ca_old",
    userId: "U123",
    teamId: "T123",
    user: "Alice",
    workspace: "Example",
  });
  try {
    await f.deps.principalLinks.link({
      principalId: "oidc:alice",
      canonicalId: "alice",
      evidence: "test",
      linkedBy: "admin",
    });
    const identity = { userId: canonical, userIds: [canonical, alias] };
    assert.deepEqual((await f.invoke("/v1/composio/identity")).data, identity);
    assert.deepEqual(
      (await f.invoke("/v1/composio/identity", undefined, null, { ...privateCap, actorId: "oidc:alice" })).data,
      identity,
    );
    f.replies.push({
      items: [
        account,
        { ...account, id: "ca_new", user_id: canonical },
        { ...account, user_id: composioUserId(orgId(), "bob") },
        { ...account, user_id: composioUserId("other-org", "oidc:alice") },
      ],
      next_cursor: "next",
    });
    const listed = await f.invoke("/v1/composio/connections?cursor=page");
    assert.deepEqual(listed.data, {
      items: [
        { id: "ca_old", toolkit: "slack", userId: alias, missingScopes: [] },
        { id: "ca_new", toolkit: "slack", userId: canonical, missingScopes: [] },
      ],
      nextCursor: "next",
    });
    assert.equal(new URL(f.calls[0]!.url).searchParams.get("user_ids"), [canonical, alias].join(","));
    assert.equal(new URL(f.calls[0]!.url).searchParams.get("cursor"), "page");
    await f.deps.slackAccounts.put("alice", {
      ...(await f.deps.slackAccounts.get("oidc:alice"))!,
      principalId: "alice",
      accountId: "ca_expired",
    });
    f.replies.push({ ...account, id: "ca_expired", user_id: canonical, status: "EXPIRED" }, account);
    assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
    await f.deps.slackAccounts.delete("alice");
    f.replies.push(
      { session_id: "trs_test" },
      { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test" },
    );
    assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail" }, "oidc:alice")).status, 200);
    assert.equal(JSON.parse(String(f.calls[3]!.init?.body)).user_id, canonical);
    await f.deps.principalLinks.unlink("oidc:alice");
    f.replies.push({ items: [account], next_cursor: null });
    assert.deepEqual((await f.invoke("/v1/composio/connections")).data.items, []);
    assert.equal((await f.invoke("/v1/composio/slack")).data.connected, false);
  } finally {
    installPrincipalLinks(null);
  }
});

test("authorization failures keep a redacted upstream cause for operators", async (t) => {
  const f = fixture();
  await f.own();
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logged.push(args.map(String).join(" ")));
  f.replies.push(
    new Response(JSON.stringify({ error: "toolkit not enabled", echoed: "private-key", api_key: "sk-other" }), {
      status: 400,
      headers: { "x-request-id": "req_123" },
    }),
  );
  const r = await f.invoke("/v1/composio/authorize", { toolkit: "gmail" });
  assert.equal(r.status, 502);
  assert.equal(r.data.error, "composio_authorization_failed");
  assert.doesNotMatch(r.text, /toolkit not enabled|private-key|req_123/);
  const report = logged.find((line) => line.includes("composio: authorize"));
  assert.ok(report, "authorization failure is reported");
  assert.match(report, /toolkit=gmail/);
  assert.match(report, /http 400/);
  assert.match(report, /toolkit not enabled/);
  assert.match(report, /req_123/);
  assert.doesNotMatch(report, /private-key|sk-other/);
});

async function slackReplyFixture() {
  const f = fixture();
  await f.own();
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread(
    "ch:C123:123.456",
    "channel",
    scopeId("personal", "alice"),
    undefined,
    "slack",
  );
  f.deps.sessions = sessions;
  f.app.getSessionForViewer = async (id, viewer) => (id === "session" && viewer === "alice" ? { session } : null);
  const receipts = async () =>
    (await sessions.getItems(session.id)).map((e): Record<string, unknown> => ({
      kind: e.kind,
      text: e.text,
      externalId: e.externalId,
      ...e.body,
    }));
  f.deps.slackAccounts = createMemoryMap();
  await f.deps.slackAccounts.put("alice", {
    principalId: "alice",
    memberId: "alice",
    accountId: "ca_alice",
    userId: "U123",
    teamId: "T123",
    user: "Alice",
    workspace: "Test",
  });
  const account = {
    id: "ca_alice",
    user_id: composioUserId(orgId(), "alice"),
    toolkit: { slug: "slack" },
    status: "ACTIVE",
  };
  const identity = { data: { ok: true, user_id: "U123", team_id: "T123" } };
  const message = { sessionId: "session", text: "Hello", clientMessageId: "01234567-0123-4123-8123-012345678901" };
  return { ...f, account, identity, message, sessions, receipts };
}

test("Slack replies use only the viewer's verified user connection and server-side thread destination", async () => {
  const f = await slackReplyFixture();
  f.replies.push(f.account, f.identity, { data: { ok: true } }, { data: { ok: true, ts: "123.789" } });
  const result = await f.invoke("/v1/composio/slack/reply", {
    ...f.message,
    channel: "CATTACK",
    accountId: "ca_other",
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.sent, true);
  const receipts = await f.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.kind, "UserMessage");
  assert.equal(receipts[0]!.text, "Hello");
  assert.equal(receipts[0]!.externalId, "123.789");
  assert.equal(receipts[0]!.name, "Alice");
  assert.equal(receipts[0]!.slackReplyReceipt, true);
  const request = JSON.parse(String(f.calls.at(-1)!.init!.body));
  assert.equal(request.connected_account_id, "ca_alice");
  assert.equal(request.endpoint, "https://slack.com/api/chat.postMessage");
  assert.deepEqual(request.body, {
    channel: "C123",
    thread_ts: "123.456",
    text: "Hello",
    client_msg_id: f.message.clientMessageId,
    as_user: true,
    unfurl_links: false,
    unfurl_media: false,
  });
});

test("Slack reply status verifies personal access without posting", async () => {
  const f = await slackReplyFixture();
  f.replies.push(f.account, f.identity, { data: { ok: true } });
  assert.equal((await f.invoke("/v1/composio/slack/reply-status", f.message)).data.connected, true);
  assert.equal(f.calls.length, 3);
});

test("Slack replies cannot target hidden sessions or accept blank messages", async () => {
  const f = await slackReplyFixture();
  assert.equal((await f.invoke("/v1/composio/slack/reply", { ...f.message, sessionId: "hidden" })).status, 404);
  assert.equal((await f.invoke("/v1/composio/slack/reply", { ...f.message, text: " " })).status, 400);
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message, null)).status, 403);
  assert.equal(f.calls.length, 0);
});

test("Slack replies require a linked user account and never fall back to the bot token", async () => {
  const f = await slackReplyFixture();
  await f.deps.slackAccounts!.delete("alice");
  f.deps.slackEnvBotToken = "must-not-use";
  assert.equal((await f.invoke("/v1/composio/slack/reply-status", f.message)).data.connected, false);
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).status, 409);
  assert.equal(f.calls.length, 0);
});

for (const [label, accountPatch, identityPatch] of [
  ["another owner", { user_id: "other" }, {}],
  ["revoked connection", { status: "REVOKED" }, {}],
  ["bot token", {}, { bot_id: "B123" }],
  ["another user", {}, { user_id: "UOTHER" }],
  ["another workspace", {}, { team_id: "TOTHER" }],
] as const)
  test(`Slack replies reject ${label}`, async () => {
    const f = await slackReplyFixture();
    f.replies.push({ ...f.account, ...accountPatch }, { data: { ...f.identity.data, ...identityPatch } });
    assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).status, 409);
    assert.ok(f.calls.length <= 2);
  });

test("Slack replies preserve an uncertain send result without retrying", async () => {
  const f = await slackReplyFixture();
  f.replies.push(f.account, f.identity, { data: { ok: true } }, new Error("timeout"));
  const result = await f.invoke("/v1/composio/slack/reply", f.message);
  assert.equal(result.status, 502);
  assert.match(result.data.message, /outcome is unknown/);
  assert.equal(f.calls.length, 4);
});

test("Slack replies stop when the personal account cannot access the conversation", async () => {
  const f = await slackReplyFixture();
  f.replies.push(f.account, f.identity, { data: { ok: false, error: "channel_not_found" } });
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).status, 403);
  assert.equal(f.calls.length, 3);
});

test("Slack replies reject impersonation and agent capabilities", async () => {
  const f = await slackReplyFixture();
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message, "alice", undefined, true)).status, 403);
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message, "alice", {} as CapabilityClaims)).status, 403);
  assert.equal(f.calls.length, 0);
});

test("Slack replies preserve unthreaded DMs and report Slack permission failures", async () => {
  const f = await slackReplyFixture();
  f.app.getSessionForViewer = async () => ({ session: { threadRef: "dm:D123" } });
  f.replies.push(f.account, f.identity, { data: { ok: true } }, { data: { ok: false, error: "missing_scope" } });
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).status, 403);
  const request = JSON.parse(String(f.calls.at(-1)!.init!.body));
  assert.equal(request.body.channel, "D123");
  assert.equal("thread_ts" in request.body, false);
});

async function nativeSlackFixture(linked = true) {
  const f = await slackReplyFixture();
  const { createDirectoryStore } = await import("../src/directory/directory-store.ts");
  f.deps.slackAccounts = createMemoryMap();
  f.deps.connectorTokens = f.deps.keychain;
  f.deps.oauthEnv = { SLACK_OAUTH_CLIENT_ID: "native-client", SLACK_OAUTH_CLIENT_SECRET: "native-secret" };
  f.deps.directory = createDirectoryStore();
  await f.deps.directory.replace([{ principalId: "alice", slackId: "U123", displayName: "Alice", type: "internal" }]);
  f.deps.slackEnvBotToken = "workspace-bot";
  if (linked) await f.deps.connectorTokens!.setConnectorToken("slack.com", "alice", { accessToken: "alice-user" });
  const nativeCalls: Array<{ method: string; token: string; payload?: object }> = [];
  const nativeReplies: unknown[] = [];
  f.deps.slackWebClient = (token, options) => {
    assert.equal(options.retryConfig?.retries, 0);
    assert.equal(options.rejectRateLimitedCalls, true);
    return {
      async apiCall(method, payload) {
        nativeCalls.push({ method, token, payload });
        if (token === "workspace-bot") return { ok: true, team_id: "T123" };
        const value = nativeReplies.shift();
        if (value instanceof Error) throw value;
        if ((value as { ok?: boolean })?.ok === false)
          throw Object.assign(new Error("Slack API error"), { code: "slack_webapi_platform_error", data: value });
        return value as { ok: boolean };
      },
    };
  };
  const nativeIdentity = { ok: true, user_id: "U123", team_id: "T123", user: "Alice", team: "Test" };
  return { ...f, nativeCalls, nativeReplies, nativeIdentity };
}

test("native Slack replies use the authenticated user's token and server destination without Composio", async () => {
  const f = await nativeSlackFixture();
  f.nativeReplies.push(f.nativeIdentity, { ok: true }, { ok: true, ts: "123.789" });
  const result = await f.invoke("/v1/composio/slack/reply", { ...f.message, channel: "COTHER" });
  assert.equal(result.data.sent, true);
  const receipts = await f.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.kind, "UserMessage");
  assert.equal(receipts[0]!.text, "Hello");
  assert.equal(receipts[0]!.externalId, "123.789");
  assert.equal(receipts[0]!.name, "Alice");
  assert.equal(receipts[0]!.slackReplyReceipt, true);
  assert.equal(f.calls.length, 0);
  const sent = f.nativeCalls.at(-1)!;
  assert.equal(sent.method, "chat.postMessage");
  assert.equal(sent.token, "alice-user");
  assert.deepEqual(sent.payload, {
    channel: "C123",
    thread_ts: "123.456",
    text: "Hello",
    client_msg_id: f.message.clientMessageId,
    as_user: true,
    unfurl_links: false,
    unfurl_media: false,
  });
});

test("native Slack rejects bot, wrong person, and wrong workspace tokens", async () => {
  for (const invalid of [{ bot_id: "B123" }, { user_id: "UOTHER" }, { team_id: "TOTHER" }]) {
    const f = await nativeSlackFixture();
    f.nativeReplies.push({ ...f.nativeIdentity, ...invalid });
    const result = await f.invoke("/v1/composio/slack/reply", f.message);
    assert.equal(result.status, 409);
    assert.equal(
      f.nativeCalls.some((c) => c.method === "chat.postMessage"),
      false,
    );
  }
});

test("native Slack connection status and linking work without a Composio credential", async () => {
  const f = await nativeSlackFixture(false);
  f.deps.keychain = undefined;
  f.deps.serviceCreds = undefined;
  assert.deepEqual((await f.invoke("/v1/composio/slack")).data, {
    connected: false,
    nativeOAuth: true,
    workspaceInstalled: true,
  });
  assert.equal((await f.invoke("/v1/composio/slack/reply-status", { sessionId: "session" })).data.connected, false);
  await f.deps.connectorTokens!.setConnectorToken("slack.com", "alice", { accessToken: "alice-user" });
  f.nativeReplies.push(f.nativeIdentity);
  assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
});

test("configured native OAuth preserves an existing Composio connection", async () => {
  const f = await nativeSlackFixture(false);
  await f.deps.slackAccounts!.put("alice", {
    principalId: "alice",
    memberId: "alice",
    accountId: "ca_alice",
    userId: "U123",
    teamId: "T123",
    user: "Alice",
    workspace: "Test",
  });
  f.replies.push(f.account);
  assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
  f.replies.push(f.account, f.identity, { data: { ok: true } }, { data: { ok: true, ts: "123.789" } });
  assert.equal((await f.invoke("/v1/composio/slack/reply", f.message)).data.sent, true);
  assert.equal(f.nativeCalls.length, 0);
});

test("native Slack access denial and uncertain sends never fall through to another transport", async () => {
  for (const sending of [false, true]) {
    const f = await nativeSlackFixture();
    f.nativeReplies.push(f.nativeIdentity, { ok: sending });
    if (sending) f.nativeReplies.push(new Error("timeout"));
    const result = await f.invoke("/v1/composio/slack/reply", f.message);
    assert.equal(result.status, sending ? 502 : 403);
    if (sending) assert.match(result.data.message, /outcome is unknown/);
    assert.equal(f.calls.length, 0);
  }
});

test("a confirmed Slack send is distinguished from a failed transcript write", async () => {
  const f = await slackReplyFixture();
  f.sessions.appendMany = async () => {
    throw new Error("database unavailable");
  };
  f.replies.push(f.account, f.identity, { data: { ok: true } }, { data: { ok: true, ts: "123.789" } });
  const result = await f.invoke("/v1/composio/slack/reply", f.message);
  assert.equal(result.status, 502);
  assert.equal(result.data.error, "transcript_unavailable");
  assert.match(result.data.message, /Slack sent your message.*Do not resend/);
});

test("Slack reply failures redact both provider credentials from diagnostics", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logged.push(args.map(String).join(" ")));
  const composio = await slackReplyFixture();
  composio.replies.push(new Response("provider rejected private-key", { status: 502 }));
  assert.equal((await composio.invoke("/v1/composio/slack/reply", composio.message)).status, 502);
  const native = await nativeSlackFixture();
  native.nativeReplies.push(new Error("provider rejected alice-user"));
  assert.equal((await native.invoke("/v1/composio/slack/reply", native.message)).status, 502);
  assert.match(logged.join("\n"), /provider rejected/);
  assert.doesNotMatch(logged.join("\n"), /private-key|alice-user/);
});
