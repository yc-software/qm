import { test } from "node:test";
import assert from "node:assert/strict";
import { composioUserId } from "../../../src/api/routes/composio.ts";
import { scopeId } from "../../../src/types.ts";
import { tenant } from "../../../src/tenant.ts";
import { testAdvisoryLock } from "../../support/test-database.ts";
import { fakeRuns, fixture, privateCap } from "../../support/composio-routes.ts";
import { createSlackAccounts } from "../../../src/connectors/composio-links.ts";
import { testQuery } from "../../support/test-database.ts";
const execution = {
  tool: "GMAIL_FETCH_EMAILS",
  accountId: "ca_alice",
  version: "20260901_00",
  arguments: { max_results: 1 },
};
const aliceAccount = {
  id: "ca_alice",
  user_id: composioUserId(tenant().orgId, "alice"),
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
    user_id: composioUserId(tenant().orgId, "alice"),
    connected_account_id: "ca_alice",
    version: execution.version,
    arguments: execution.arguments,
  });
  assert.doesNotMatch(result.text, /company-key|hidden/);
});

test("execution rejects other owners, inactive accounts, disabled accounts, and mismatched toolkits", async () => {
  for (const account of [
    { ...aliceAccount, user_id: composioUserId(tenant().orgId, "bob") },
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

test("capabilities without owner authorization and deployments fail before provider calls", async () => {
  for (const cap of [
    { ...privateCap, ownerConnections: undefined },
    { ...privateCap, deployment: "app" },
    { ...privateCap, botActor: true },
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
    user_id: composioUserId(tenant().orgId, "alice"),
  });
  assert.equal((await testQuery(f.url, "SELECT * FROM composio_returns")).length, 0);
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
  f.deps.runs = fakeRuns({ status: "done" });
  assert.equal((await f.invoke("/v1/composio/connections", undefined, null, privateCap)).status, 403);
  assert.equal(f.calls.length, 0);
});

test("ending the run during account lookup prevents execution", async () => {
  const f = fixture();
  await f.own();
  const original = f.deps.composioFetch!;
  f.deps.composioFetch = async (...args) => {
    const response = await original(...args);
    f.deps.runs = fakeRuns({ status: "done" });
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
    f.deps.runs = fakeRuns({ status: "done" });
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
  const org = tenant().orgScope;
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
  const key = `${composioUserId(tenant().orgId, "alice")}:ca_test`;
  await f.deps.composioReturns!.put(key, {
    url: "https://qm.example/old",
    toolkit: "gmail",
    expiresAt: Date.now() - 1,
  });
  f.replies.push({ connected_account_id: "ca_test" });
  assert.deepEqual((await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque" })).data, { returnTo: null });
  assert.equal((await testQuery(f.url, "SELECT * FROM composio_returns")).length, 0);
});

test("linked aliases can execute their existing accounts until the identity link is removed", async () => {
  const { createPrincipalLinkService } = await import("../../../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../../../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  const links = createPrincipalLinkService(f.url, testAdvisoryLock());
  installPrincipalLinks(links);
  const aliasId = "oidc:alice";
  const aliasUserId = composioUserId(tenant().orgId, aliasId);
  const account = { ...aliceAccount, user_id: aliasUserId };
  try {
    await links.link({ principalId: aliasId, canonicalId: "alice", linkedBy: "admin" });
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
  const { createPrincipalLinkService } = await import("../../../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../../../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  const links = createPrincipalLinkService(f.url, testAdvisoryLock());
  f.deps.principalLinks = links;
  f.deps.slackAccounts = createSlackAccounts(f.url);
  installPrincipalLinks(links);
  const aliasId = "oidc:alice";
  const canonicalUserId = composioUserId(tenant().orgId, "alice");
  const aliasUserId = composioUserId(tenant().orgId, aliasId);
  const account = { id: "ca_legacy", user_id: aliasUserId, status: "ACTIVE", toolkit: { slug: "slack" } };
  await f.deps.slackAccounts.put({
    principalId: aliasId,
    memberId: "alice",
    accountId: account.id,
    userId: "U123",
    teamId: "T123",
    user: "Alice",
    workspace: "Example",
  });
  try {
    await links.link({ principalId: aliasId, canonicalId: "alice", linkedBy: "admin" });
    f.replies.push({
      items: [
        account,
        { ...account, id: "ca_current", user_id: canonicalUserId },
        { ...account, id: "ca_other", user_id: composioUserId(tenant().orgId, "bob") },
        { ...account, id: "ca_other_org", user_id: composioUserId("other-org", aliasId) },
      ],
      next_cursor: "next",
    });
    const listed = await f.invoke("/v1/composio/connections?cursor=page");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.data.items, [
      { id: "ca_legacy", toolkit: "slack", userId: composioUserId(tenant().orgId, aliasId), missingScopes: [] },
      { id: "ca_current", toolkit: "slack", userId: composioUserId(tenant().orgId, "alice"), missingScopes: [] },
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
  const { createPrincipalLinkService } = await import("../../../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../../../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  const links = createPrincipalLinkService(f.url, testAdvisoryLock());
  installPrincipalLinks(links);
  const aliasId = "oidc:alice";
  try {
    await links.link({ principalId: aliasId, canonicalId: "alice", linkedBy: "admin" });
    const original = f.deps.composioFetch!;
    f.deps.composioFetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes(`/tools/${execution.tool}?`)) await links.unlink(aliasId);
      return response;
    };
    f.replies.push({ ...aliceAccount, user_id: composioUserId(tenant().orgId, aliasId) }, gmailTool);
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
  const { createPrincipalLinkService } = await import("../../../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../../../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  const links = createPrincipalLinkService(f.url, testAdvisoryLock());
  installPrincipalLinks(links);
  const aliasId = "oidc:alice";
  const userId = composioUserId(tenant().orgId, "alice");
  const callbackUrl = "https://qm.example/s/chat?composioReturn=linked";
  try {
    await links.link({ principalId: aliasId, canonicalId: "alice", linkedBy: "admin" });
    f.replies.push(
      { session_id: "trs_linked" },
      { redirect_url: "https://connect.composio.dev/link/lk_linked", connected_account_id: "ca_linked" },
    );
    assert.equal((await f.invoke("/v1/composio/authorize", { toolkit: "gmail", callbackUrl }, aliasId)).status, 200);
    assert.equal(JSON.parse(String(f.calls[0]!.init?.body)).user_id, userId);
    assert.equal((await testQuery(f.url, "SELECT * FROM composio_returns"))[0]?.url, callbackUrl);
    f.replies.push({ connected_account_id: "ca_linked", toolkit_slug: "gmail" });
    const result = await f.invoke("/v1/composio/complete-auth", { sessionUri: "opaque" }, aliasId);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { returnTo: callbackUrl });
    assert.deepEqual(JSON.parse(String(f.calls.at(-1)!.init?.body)), { session_uri: "opaque", user_id: userId });
    assert.equal((await testQuery(f.url, "SELECT * FROM composio_returns")).length, 0);
  } finally {
    installPrincipalLinks(null);
  }
});

test("linked identities retain provider accounts and Slack status until unlinked", async () => {
  const { createPrincipalLinkService } = await import("../../../src/identity/principal-links.ts");
  const { installPrincipalLinks } = await import("../../../src/directory/person.ts");
  const f = fixture();
  await f.shared();
  f.deps.principalLinks = createPrincipalLinkService(f.url, testAdvisoryLock());
  f.deps.slackAccounts = createSlackAccounts(f.url);
  installPrincipalLinks(f.deps.principalLinks);
  const canonical = composioUserId(tenant().orgId, "alice");
  const alias = composioUserId(tenant().orgId, "oidc:alice");
  const account = { id: "ca_old", user_id: alias, status: "ACTIVE", toolkit: { slug: "slack" } };
  await f.deps.slackAccounts.put({
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
        { ...account, user_id: composioUserId(tenant().orgId, "bob") },
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
    await f.deps.slackAccounts.put({
      ...(await f.deps.slackAccounts.get("oidc:alice"))!,
      principalId: "alice",
      accountId: "ca_expired",
    });
    f.replies.push({ ...account, id: "ca_expired", user_id: canonical, status: "EXPIRED" }, account);
    assert.equal((await f.invoke("/v1/composio/slack")).data.connected, true);
    await testQuery(f.url, `DELETE FROM slack_accounts WHERE principal_id = 'alice'`);
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
