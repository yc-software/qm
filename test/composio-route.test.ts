import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { composioRoutes } from "../src/api/routes/composio.ts";
import {
  composioUserId,
  createMemoryPrincipalStore,
  createPrincipalGraph,
  handle,
  type PrincipalGraph,
} from "../src/identity/principals.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";
import { orgId } from "../src/config.ts";

const ALICE = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const BOB = "7a2d3c4b-5e6f-4071-9b8c-0d1e2f3a4b5c";

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
    principals: undefined,
    keychain,
    serviceCreds: keychain,
    acl,
    composioReturns: createMemoryMap(),
    runs: {
      get: async () => ({
        status: "running",
        sessionId: "cron:test-cron:fire:test-fire",
        attempts: 1,
        leaseToken: "test-lease",
        leaseExpiresAt: Date.now() + 60_000,
        request: { actor: { id: ALICE } },
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
  async function invoke(path: string, body?: unknown, actor: string | null = ALICE, capability?: CapabilityClaims) {
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
  async function own(ownerId = ALICE, service = "composio") {
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
  const ready = seededGraph().then((graph) => {
    deps.principals ??= graph;
  });
  const invokeReady = async (...args: Parameters<typeof invoke>) => {
    await ready;
    return invoke(...args);
  };
  return { invoke: invokeReady, own, shared, calls, replies, deps, ready };
}

async function seededGraph(): Promise<PrincipalGraph> {
  const store = createMemoryPrincipalStore();
  for (const [id, name] of [
    [ALICE, "Alice"],
    [BOB, "Bob"],
  ] as const) {
    const row = (provider: "slack" | "composio", externalId: string) => ({
      provider,
      externalId,
      principalId: id,
      email: null,
      verifiedAt: null,
      linkedBy: "self",
      evidence: null,
      updatedAt: 0,
    });
    await store.createForIdentity(
      { principalId: id, kind: "person", displayName: name, createdAt: 0 },
      row("slack", `U_${name}`),
    );
    await store.putIdentity(row("composio", composioUserId(orgId(), id)));
  }
  const graph = createPrincipalGraph(store);
  await graph.refresh(true);
  return graph;
}

const legacyComposioUser = (f: { deps: Partial<ServerDeps> }, legacyHandle: string) => {
  const id = handle("composio", composioUserId(orgId(), legacyHandle));
  return {
    link: () => f.deps.principals!.attach(id, ALICE, "platform:migration", "pre-identity data"),
    unlink: () => f.deps.principals!.unlink(id),
  };
};

test("Composio requires a verified actor and never uses another person's key", async () => {
  const f = fixture();
  await f.own(BOB);
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
  await f.own(ALICE, "another-project");
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
    const r = await f.invoke("/v1/composio/authorize", { toolkit: "gmail", user_id: BOB, principalId: BOB });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { url: link, accountId: "ca_test" });
    const payload = JSON.parse(String(f.calls[0]!.init?.body));
    assert.equal(payload.user_id, composioUserId(orgId(), ALICE));
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
  assert.notEqual(composioUserId("a", ALICE), composioUserId("b", ALICE));
  assert.notEqual(composioUserId("a", ALICE), composioUserId("a", BOB));
  assert.deepEqual((await f.invoke("/v1/composio/identity")).data, {
    userId: composioUserId(orgId(), ALICE),
    userIds: [composioUserId(orgId(), ALICE)],
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
    user_id: composioUserId(orgId(), ALICE),
    status: "ACTIVE",
    toolkit: { slug: "gmail" },
    data: { token: "secret-token" },
  };
  f.replies.push({
    items: [
      owned,
      { ...owned, id: "ca_other", user_id: composioUserId(orgId(), BOB) },
      { ...owned, status: "INITIATED" },
      { ...owned, is_disabled: true },
    ],
    next_cursor: "next-page",
  });
  const r = await f.invoke("/v1/composio/connections?user_ids=bob&cursor=page-1");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, {
    items: [{ id: "ca_gmail", toolkit: "gmail", userId: composioUserId(orgId(), ALICE) }],
    nextCursor: "next-page",
  });
  const q = new URL(f.calls[0]!.url).searchParams;
  assert.equal(q.get("user_ids"), composioUserId(orgId(), ALICE));
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
  const { createDirectoryStore } = await import("../src/directory/directory-store.ts");
  const { installPrincipalResolver } = await import("../src/directory/person.ts");
  const { createPrincipalGraph } = await import("../src/identity/principals.ts");
  f.deps.principals = createPrincipalGraph();
  const alice = await f.deps.principals.act(handle("slack", ALICE));
  const slackPerson = await f.deps.principals.act(handle("slack", "U123"), { email: "work@example.test" });
  installPrincipalResolver(f.deps.principals);
  await f.own(alice);
  f.deps.slackAccounts = createMemoryMap();
  f.deps.signingSecret = "qa-slack-link-secret";
  f.deps.directory = createDirectoryStore();
  await f.deps.directory.replace([
    { principalId: slackPerson, slackId: "U123", displayName: "Alice", type: "internal" },
  ]);
  f.deps.slackEnvBotToken = "bot-test";
  f.deps.slackInstallationFetch = (async () => Response.json({ ok: true, team_id: "T123" })) as typeof fetch;
  try {
    f.replies.push(
      { session_id: "trs_test" },
      { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test" },
    );
    const started = await f.invoke("/v1/composio/slack/authorize", {}, alice);
    assert.equal(started.status, 200);
    const account = {
      id: "ca_test",
      user_id: composioUserId(orgId(), alice),
      toolkit: { slug: "slack" },
      status: "ACTIVE",
    };
    f.replies.push(account, { data: { ok: true, user_id: "U123", team_id: "T123", user: "alice", team: "Acme" } });
    const linked = await f.invoke("/v1/composio/slack/complete", { ticket: started.data.ticket }, alice);
    assert.equal(linked.status, 200);
    assert.equal(f.deps.principals.principalOf(handle("slack", "U123")), alice);
    assert.equal((await f.deps.principals.principals()).length, 1);
    assert.equal((await f.deps.slackAccounts.get(alice))?.accountId, "ca_test");
    f.replies.push(account);
    assert.equal((await f.invoke("/v1/composio/slack", undefined, alice)).data.connected, true);
    f.replies.push({ ...account, status: "REVOKED" });
    assert.equal((await f.invoke("/v1/composio/slack", undefined, alice)).data.connected, false);
    f.replies.push(account, { data: { ok: true, user_id: "U123", team_id: "T123", user: "alice", team: "Acme" } });
    assert.equal((await f.invoke("/v1/composio/slack/complete", { ticket: started.data.ticket }, alice)).status, 200);
  } finally {
    installPrincipalResolver(null);
  }
});

test("Slack link rejects changed browser accounts, wrong owner, bots, other workspaces and inactive connections", async () => {
  const { createDirectoryStore } = await import("../src/directory/directory-store.ts");
  const { mintSignedPayload } = await import("../src/auth/signed-token.ts");
  for (const scenario of ["expired", "other-browser", "wrong-owner", "bot", "wrong-workspace", "pending"]) {
    const f = fixture();
    await f.own();
    await f.own(BOB);
    f.deps.signingSecret = "slack-test";
    await f.ready;
    const before = (await f.deps.principals!.identities()).length;
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
        principal: ALICE,
        org: orgId(),
        accountId: "ca_test",
        exp: Date.now() + (scenario === "expired" ? -1000 : 60000),
      },
      "slack-test",
    );
    f.replies.push(
      {
        id: "ca_test",
        user_id: composioUserId(orgId(), scenario === "wrong-owner" ? BOB : ALICE),
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
    const result = await f.invoke(
      "/v1/composio/slack/complete",
      { ticket },
      scenario === "other-browser" ? BOB : ALICE,
    );
    assert.ok(result.status >= 400, `${scenario}: ${result.status}`);
    assert.equal((await f.deps.principals!.identities()).length, before, `${scenario}: no identity was linked`);
    assert.equal(f.deps.principals!.principalOf(handle("slack", "U123")), undefined);
    assert.equal((await f.deps.slackAccounts.all()).length, 0);
  }
});

const privateCap: CapabilityClaims = {
  runId: "test-run",
  sessionId: "test-session",
  threadRef: "cron:test-cron:fire:test-fire",
  runAttempt: 1,
  runLeaseToken: "test-lease",
  actorId: ALICE,
  scopeId: `personal:${ALICE}`,
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
  user_id: composioUserId(orgId(), ALICE),
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
    user_id: composioUserId(orgId(), ALICE),
    connected_account_id: "ca_alice",
    version: execution.version,
    arguments: execution.arguments,
  });
  assert.doesNotMatch(result.text, /company-key|hidden/);
});

test("execution rejects other owners, inactive accounts, disabled accounts, and mismatched toolkits", async () => {
  for (const account of [
    { ...aliceAccount, user_id: composioUserId(orgId(), BOB) },
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
    { user_id: BOB },
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
  assert.deepEqual((await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque", user_id: BOB })).data, {
    returnTo: url,
  });
  assert.deepEqual(JSON.parse(f.calls[2]!.init!.body as string), {
    session_uri: "opaque",
    user_id: composioUserId(orgId(), ALICE),
  });
  assert.equal((await f.deps.composioReturns!.entries()).length, 0);
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

test("shared org connections recheck grants for every audience member", async () => {
  const f = fixture();
  await f.shared(false);
  const org = scopeId("org", orgId());
  await f.deps.acl!.grant({
    ownerScopeId: org,
    ref: "service-cred:composio",
    granteeScopeId: `personal:${ALICE}`,
    permission: "read",
    grantedBy: "admin",
  });
  const cap = {
    ...privateCap,
    scopeId: "channel:C1",
    liveActor: false,
    triggered: true,
    keychainMembers: [
      { id: ALICE, type: "internal" as const },
      { id: BOB, type: "internal" as const },
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
  const key = `${composioUserId(orgId(), ALICE)}:ca_test`;
  await f.deps.composioReturns!.put(key, { url: "https://qm.example/old", expiresAt: Date.now() - 1 });
  f.replies.push({ connected_account_id: "ca_test" });
  assert.deepEqual((await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque" })).data, { returnTo: null });
  assert.equal(await f.deps.composioReturns!.get(key), null);
});

test("a connection made before the identity migration still executes for its owner, and stops once unlinked", async () => {
  const f = fixture();
  await f.shared();
  await f.ready;
  const legacy = legacyComposioUser(f, "oidc:alice");
  const legacyUserId = composioUserId(orgId(), "oidc:alice");
  const account = { ...aliceAccount, user_id: legacyUserId };
  await legacy.link();
  f.replies.push(account, gmailTool, { successful: true, data: { emails: [] } });
  assert.equal((await f.invoke("/v1/composio/execute", execution, null, privateCap)).status, 200);
  assert.deepEqual(JSON.parse(String(f.calls.at(-1)!.init?.body)), {
    user_id: legacyUserId,
    connected_account_id: account.id,
    version: execution.version,
    arguments: execution.arguments,
  });
  const asBob = { ...privateCap, actorId: BOB, scopeId: scopeId("personal", BOB) };
  f.replies.push(account);
  assert.equal((await f.invoke("/v1/composio/execute", execution, null, asBob)).status, 403, "never another owner");
  await legacy.unlink();
  const before = f.calls.length;
  f.replies.push(account);
  const revoked = await f.invoke("/v1/composio/execute", execution, null, privateCap);
  assert.equal(revoked.status, 403);
  assert.equal(revoked.data.error, "connection_not_authorized");
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.calls.at(-1)!.init?.method, "GET");
});

test("connection discovery and Slack status include pre-migration Composio users without exposing other owners", async () => {
  const f = fixture();
  await f.shared();
  await f.ready;
  f.deps.slackAccounts = createMemoryMap();
  const legacy = legacyComposioUser(f, "oidc:alice");
  const canonicalUserId = composioUserId(orgId(), ALICE);
  const legacyUserId = composioUserId(orgId(), "oidc:alice");
  const account = { id: "ca_legacy", user_id: legacyUserId, status: "ACTIVE", toolkit: { slug: "slack" } };
  await f.deps.slackAccounts.put(ALICE, {
    principalId: ALICE,
    memberId: ALICE,
    accountId: account.id,
    userId: "U123",
    teamId: "T123",
    user: "Alice",
    workspace: "Example",
  });
  await legacy.link();
  f.replies.push({
    items: [
      account,
      { ...account, id: "ca_current", user_id: canonicalUserId },
      { ...account, id: "ca_other", user_id: composioUserId(orgId(), BOB) },
      { ...account, id: "ca_other_org", user_id: composioUserId("other-org", "oidc:alice") },
    ],
    next_cursor: "next",
  });
  const listed = await f.invoke("/v1/composio/connections?cursor=page");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.items, [
    { id: "ca_legacy", toolkit: "slack", userId: legacyUserId },
    { id: "ca_current", toolkit: "slack", userId: canonicalUserId },
  ]);
  assert.equal(listed.data.nextCursor, "next");
  const query = new URL(f.calls.at(-1)!.url).searchParams;
  assert.deepEqual(query.get("user_ids")!.split(",").sort(), [canonicalUserId, legacyUserId].sort());
  assert.equal(query.get("cursor"), "page");
  f.replies.push(account);
  assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
  await legacy.unlink();
  f.replies.push({ items: [account] });
  assert.deepEqual((await f.invoke("/v1/composio/connections")).data.items, []);
  f.replies.push(account);
  assert.equal((await f.invoke("/v1/composio/slack")).data.connected, false);
});

test("unlinking an account owner during tool lookup prevents provider execution", async () => {
  const f = fixture();
  await f.shared();
  await f.ready;
  const legacy = legacyComposioUser(f, "oidc:alice");
  await legacy.link();
  const original = f.deps.composioFetch!;
  f.deps.composioFetch = async (...args) => {
    const response = await original(...args);
    if (String(args[0]).includes(`/tools/${execution.tool}?`)) await legacy.unlink();
    return response;
  };
  f.replies.push({ ...aliceAccount, user_id: composioUserId(orgId(), "oidc:alice") }, gmailTool);
  const result = await f.invoke("/v1/composio/execute", execution, null, privateCap);
  assert.equal(result.status, 403);
  assert.equal(result.data.error, "connection_not_authorized");
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.init?.method === "GET"));
});

test("consent and browser verification hash the principal the edge resolved", async () => {
  const f = fixture();
  await f.shared();
  const principal = ALICE;
  const userId = composioUserId(orgId(), principal);
  const callbackUrl = "https://qm.example/s/chat?composioReturn=linked";
  f.replies.push(
    { session_id: "trs_linked" },
    { redirect_url: "https://connect.composio.dev/link/lk_linked", connected_account_id: "ca_linked" },
  );
  assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail", callbackUrl }, principal)).status, 200);
  assert.equal(JSON.parse(String(f.calls[0]!.init?.body)).user_id, userId);
  assert.equal((await f.deps.composioReturns!.get(`${userId}:ca_linked`))?.url, callbackUrl);
  f.replies.push({ connected_account_id: "ca_linked", toolkit_slug: "gmail" });
  const result = await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque" }, principal);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { returnTo: callbackUrl });
  assert.deepEqual(JSON.parse(String(f.calls.at(-1)!.init?.body)), { session_uri: "opaque", user_id: userId });
  assert.equal((await f.deps.composioReturns!.entries()).length, 0);
});

test("the identity endpoint names the principal's own Composio user first, then its pre-migration ones", async () => {
  const f = fixture();
  await f.shared();
  await f.ready;
  const canonical = composioUserId(orgId(), ALICE);
  const legacy = composioUserId(orgId(), "oidc:alice");
  await legacyComposioUser(f, "oidc:alice").link();
  const identity = (await f.invoke("/v1/composio/identity")).data;
  assert.equal(identity.userId, canonical);
  assert.deepEqual([...identity.userIds].sort(), [canonical, legacy].sort());
  f.replies.push(
    { session_id: "trs_test" },
    { redirect_url: "https://connect.composio.dev/link/lk_test", connected_account_id: "ca_test" },
  );
  assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail" }, ALICE)).status, 200);
  assert.equal(JSON.parse(String(f.calls[0]!.init?.body)).user_id, canonical, "new connections use the principal's id");
});
