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

function fixture() {
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("composio-test"),
  });
  const acl = createAclStore();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const replies: unknown[] = [];
  const deps: Partial<ServerDeps> = {
    keychain,
    serviceCreds: keychain,
    acl,
    composioReturns: createMemoryMap(),
    runs: {
      get: async () => ({
        status: "running",
        sessionId: "test-session",
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
      return Response.json(result);
    }) as typeof fetch,
  };
  async function invoke(path: string, body?: unknown, actor: string | null = "alice", capability?: CapabilityClaims) {
    let status = 0;
    let text = "";
    const url = new URL(path, "http://localhost");
    const res = {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        text = value;
      },
    } as unknown as ServerResponse;
    const ctx = {
      deps,
      res,
      url,
      body,
      capability,
      actor: actor ? { p: actor, exp: Date.now() + 60_000 } : null,
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
  return { invoke, own, shared, calls, replies, deps };
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
    items: [{ id: "ca_gmail", toolkit: "gmail", userId: composioUserId(orgId(), "alice") }],
    nextCursor: "next-page",
  });
  const q = new URL(f.calls[0]!.url).searchParams;
  assert.equal(q.get("user_ids"), composioUserId(orgId(), "alice"));
  assert.equal(q.get("statuses"), "ACTIVE");
  assert.equal(q.get("cursor"), "page-1");
  assert.doesNotMatch(r.text, /secret-token|private-key|user_id/);
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

test("execution never retries a provider failure", async () => {
  const f = fixture();
  await f.own();
  f.replies.push(aliceAccount, gmailTool, new Error("uncertain write"));
  assert.equal((await f.invoke("/v1/composio/execute", execution, null, privateCap)).status, 502);
  assert.equal(f.calls.length, 3);
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
});

test("finished runs and stale lease capabilities cannot reuse backend connection access", async () => {
  for (const patch of [{ runId: undefined }, { runLeaseToken: "stale" }, { runAttempt: 2 }, { sessionId: "another" }]) {
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
  await f.deps.composioReturns!.put(key, { url: "https://qm.example/old", expiresAt: Date.now() - 1 });
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
      { id: "ca_legacy", toolkit: "slack", userId: composioUserId(orgId(), aliasId) },
      { id: "ca_current", toolkit: "slack", userId: composioUserId(orgId(), "alice") },
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
        { id: "ca_old", toolkit: "slack", userId: alias },
        { id: "ca_new", toolkit: "slack", userId: canonical },
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
