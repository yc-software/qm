import "./support/auto-fake-sprites.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { orgId, orgScope } from "../src/config.ts";
import { testConfig } from "./support/test-config.ts";

const signing = "synthetic-portal-signing-key-for-integration-tests";
const user = "alice@example.com";
const expectedUser = `qm_${createHash("sha256")
  .update(JSON.stringify([orgId(), user]))
  .digest("hex")}`;

test("live core callback requires signed browser identity and registers only a verified private account", async () => {
  const built = buildApp(testConfig({ signingSecret: signing }));
  const kc = built.keychain!;
  await kc.setServiceCredential(orgScope(), {
    slug: "apps",
    name: "Apps",
    secret: "project-sentinel",
    provider: "composio",
    host: "backend.composio.dev",
  });
  await built.acl.grant({
    ownerScopeId: orgScope(),
    ref: "service-cred:apps",
    granteeScopeId: orgScope(),
    permission: "read",
    grantedBy: user,
  });
  const server = createServer(built.app, {
    signingSecret: signing,
    capabilitySecret: signing,
    keychain: kc,
    serviceCreds: kc,
    acl: built.acl,
    identity: built.identity,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const originalFetch = globalThis.fetch;
  let completionPosts = 0;
  let consumed = false;
  let active = true;
  const http = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "https://backend.composio.dev") return originalFetch(input, init);
    if (url.pathname.endsWith("/complete_auth")) {
      completionPosts++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.session_uri, "opaque-session");
      if (body.user_id !== expectedUser || consumed)
        return Response.json({ error: "wrong identity or replay" }, { status: 403 });
      consumed = true;
      return Response.json({ connected_account_id: "ca_verified", toolkit_slug: "googlecalendar" });
    }
    return Response.json({
      id: "ca_verified",
      toolkit: { slug: "googlecalendar" },
      status: active ? "ACTIVE" : "FAILED",
      status_reason: null,
      is_disabled: false,
      auth_config: { id: "ac_test", auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false },
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      experimental: { account_type: "PRIVATE" },
      data: { access_token: "never-expose-provider-token" },
    });
  });
  const callback = async (clicker = user, org = orgId(), credentialPath = "") => {
    const path = `/v1/connectors/composio/complete${credentialPath}?session_uri=opaque-session&nonce=${randomUUID()}`;
    const ts = Math.floor(Date.now() / 1000);
    return fetch(base + path, {
      headers: {
        "x-timestamp": String(ts),
        "x-signature": signRequest(signing, ts, `GET\n${path}\n`),
        "x-consent-clicker": clicker,
        "x-consent-clicker-org": org,
      },
    });
  };
  try {
    const unsigned = await fetch(`${base}/v1/connectors/composio/complete?session_uri=opaque-session`, {
      headers: { "x-consent-clicker": user, "x-consent-clicker-org": orgId() },
    });
    assert.equal(unsigned.status, 401);
    const cap = await mintCapabilityToken(
      { actorId: user, scopeId: `personal:${user}`, aud: "control-plane", exp: Date.now() + 60_000 },
      signing,
    );
    const agent = await fetch(`${base}/v1/connectors/composio/complete?session_uri=opaque-session`, {
      headers: { "x-agent-capability": cap, "x-consent-clicker": user, "x-consent-clicker-org": orgId() },
    });
    assert.ok(agent.status >= 400);
    assert.equal((await callback(user, "other-company")).status, 403);
    assert.equal(completionPosts, 0);
    assert.equal((await callback("bob@example.com")).status, 400);
    assert.deepEqual(await kc.listByOwner("bob@example.com"), []);
    active = false;
    assert.equal((await callback()).status, 400);
    assert.deepEqual(await kc.listByOwner(user), []);
    consumed = false;
    active = true;
    await kc.setServiceCredential(orgScope(), {
      slug: "other",
      name: "Other",
      secret: "other-sentinel",
      provider: "composio",
      host: "backend.composio.dev",
    });
    await built.acl.grant({
      ownerScopeId: orgScope(),
      ref: "service-cred:other",
      granteeScopeId: orgScope(),
      permission: "read",
      grantedBy: user,
    });
    const postsBefore = completionPosts;
    assert.equal((await callback()).status, 400);
    assert.equal(completionPosts, postsBefore, "ambiguous callback must not try keys against a single-use session");
    const good = await callback(user, orgId(), "/apps");
    assert.equal(good.status, 200);
    const result = await good.json();
    assert.deepEqual(result, { status: "connected" });
    assert.equal(JSON.stringify(result).includes("never-expose"), false);
    assert.equal((await kc.listByOwner(user))[0]?.kind, "connection");
    assert.equal((await callback()).status, 400);
    assert.equal((await kc.listByOwner(user)).length, 1);
  } finally {
    http.mock.restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
