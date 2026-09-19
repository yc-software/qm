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
    composioFetch: (async (input, init) => {
      calls.push({ url: String(input), init });
      const result = replies.shift();
      if (result instanceof Error) throw result;
      return Response.json(result);
    }) as typeof fetch,
  };
  async function invoke(path: string, body?: unknown, actor: string | null = "alice") {
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
    const ctx = { deps, res, url, body, actor: actor ? { p: actor, exp: Date.now() + 60_000 } : null } as ApiCtx;
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
  assert.deepEqual((await f.invoke("/v1/composio/identity")).data, { userId: composioUserId(orgId(), "alice") });
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
  assert.deepEqual(r.data, { items: [{ id: "ca_gmail", toolkit: "gmail" }], nextCursor: "next-page" });
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
