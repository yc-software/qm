import "./support/auto-fake-sprites.ts";

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserImpersonationCookie, browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";
import { testTenant } from "./support/test-tenant.ts";
import { scopeId, type ScopeId, personalScope } from "../src/types.ts";

async function core(t: TestContext): Promise<{ base: string; built: ReturnType<typeof buildApp> }> {
  const config = testConfig({ signingSecret: "web-keychain-signing-secret-0123456789" });
  const built = stopAtEnd(buildApp(config));
  const server = createServer(built.app, { ...serverDeps(config, built), ...browserSessionDeps });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, built };
}

const as = (cookie: string, method = "GET", body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json", cookie, origin: browserSessionDeps.portalUrl },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("a signed-in person adds, lists and removes only their own keychain entries from the browser", async (t) => {
  const { base, built } = await core(t);
  const alice = browserSessionCookie("alice");
  const bob = browserSessionCookie("bob");

  const drop = await fetch(`${base}/api/keychain/drops`, as(alice, "POST", { service: "stripe", purpose: "billing" }));
  assert.equal(drop.status, 200);
  const minted = (await drop.json()) as { dropId: string; formPath: string; url: string };
  assert.match(minted.formPath, new RegExp(`^/drop/${minted.dropId}/form\\?t=`));
  assert.equal(minted.url, `${browserSessionDeps.portalUrl}${minted.formPath}`);
  const named = await fetch(
    `${base}/api/keychain/drops`,
    as(alice, "POST", { service: "stripe", purpose: "billing", principalId: "bob" }),
  );
  assert.equal(named.status, 403);
  const onBehalf = await fetch(
    `${base}/api/keychain/drops`,
    as(alice, "POST", { service: "stripe", purpose: "billing", onBehalfOf: "bob" }),
  );
  assert.equal(onBehalf.status, 403);

  const saved = await built.keychain!.save({ ownerId: "alice", service: "stripe", envKey: "STRIPE_KEY", secret: "sk" });
  const overview = (await (await fetch(`${base}/api/keychain/overview`, as(alice))).json()) as {
    credentials: Array<{ id: string }>;
  };
  assert.deepEqual(
    overview.credentials.map((c) => c.id),
    [saved.id],
  );
  const bobView = (await (await fetch(`${base}/api/keychain/overview`, as(bob))).json()) as { credentials: unknown[] };
  assert.deepEqual(bobView.credentials, []);

  assert.equal((await fetch(`${base}/api/keychain/credentials/${saved.id}`, as(bob, "DELETE"))).status, 404);
  const impersonating = `${browserSessionCookie("admin-alice")}; ${browserImpersonationCookie("admin-alice", "alice")}`;
  const refusal = [403, { error: "forbidden", message: "Unavailable while impersonating." }];
  const routes = {
    POST: [
      "/v1/connectors/oauth/revoke",
      "/v1/keychain/grants/missing/revoke",
      "/v1/personas/missing/credentials",
      "/v1/user-model-auth/disconnect",
      "/v1/user-model-auth/api-key",
      "/v1/user-model-auth/chatgpt/poll",
      "/v1/user-model-auth/claude/complete",
      "/v1/user-model-auth/account",
      "/v1/user-model-auth/chatgpt/start",
      "/v1/user-model-auth/claude/start",
      "/v1/connectors/oauth/google/start",
    ],
    DELETE: [`/v1/keychain/credentials/${saved.id}`, "/v1/personas/missing", "/v1/personas/missing/credentials/x"],
    PATCH: ["/v1/runs/missing/input"],
  };
  for (const [method, paths] of Object.entries(routes))
    for (const path of paths) {
      const res = await fetch(`${base}${path}`, as(impersonating, method, {}));
      assert.deepEqual([res.status, await res.json()], refusal, path);
    }
  assert.equal((await built.keychain!.listByOwner("alice")).length, 1);
  assert.equal((await fetch(`${base}/api/keychain/credentials/${saved.id}`, as(alice, "DELETE"))).status, 200);
  assert.equal((await built.keychain!.listByOwner("alice")).length, 0);
  assert.equal((await fetch(`${base}/api/keychain/grants/missing/revoke`, as(alice, "POST", {}))).status, 404);
});

test("persona deletes, attaches and detaches are audited with the grants they revoke, and impersonation is named", async (t) => {
  const { base, built } = await core(t);
  const alice = browserSessionCookie("alice");
  await built.featureFlags.setEnabled("personas", personalScope("alice"), true, "test");
  const created = await fetch(`${base}/api/personas`, as(alice, "POST", { name: "Ada" }));
  const { id } = ((await created.json()) as { persona: { id: string } }).persona;
  const attach = async () => {
    const saved = await built.keychain!.save({
      ownerId: "alice",
      service: "stripe",
      envKey: "STRIPE_KEY",
      secret: "sk",
    });
    const res = await fetch(`${base}/api/personas/${id}/credentials`, as(alice, "POST", { credentialId: saved.id }));
    return ((await res.json()) as { credential: { grantId: string } }).credential.grantId;
  };
  const [first, second, dropped] = [await attach(), await attach(), await attach()];
  assert.equal((await fetch(`${base}/api/personas/${id}/credentials/${dropped}`, as(alice, "DELETE", {}))).status, 200);
  const keychain = built.keychain!;
  const revokeGrant = keychain.revokeGrant.bind(keychain);
  let revokes = 0;
  const failing = t.mock.method(keychain, "revokeGrant", async (ownerId: string, grantId: string) => {
    if (++revokes === 2) throw new Error("keychain unavailable");
    return revokeGrant(ownerId, grantId);
  });
  assert.equal((await fetch(`${base}/api/personas/${id}`, as(alice, "DELETE", {}))).status, 500);
  failing.mock.restore();
  assert.equal((await fetch(`${base}/api/personas/${id}`, as(alice, "DELETE", {}))).status, 200);
  const impersonating = `${browserSessionCookie("admin-alice")}; ${browserImpersonationCookie("admin-alice", "alice")}`;
  const drop = await fetch(
    `${base}/api/keychain/drops`,
    as(impersonating, "POST", { service: "stripe", purpose: "x" }),
  );
  assert.equal(drop.status, 200);
  const rows = async (filter: { scopeLabel: ScopeId }) =>
    (await built.auditLog.tail(testTenant, { limit: 20, ...filter }))
      .map((e) => [e.action, e.resource, e.principalId, e.impersonatedBy ?? "-"].join(" "))
      .sort();
  assert.deepEqual(
    await rows({ scopeLabel: scopeId("persona", id) }),
    [
      `keychain.revoke ${dropped} alice -`,
      `keychain.revoke ${first} alice -`,
      `keychain.revoke ${second} alice -`,
      `persona.credential.attach ${dropped} alice -`,
      `persona.credential.attach ${first} alice -`,
      `persona.credential.attach ${second} alice -`,
      `persona.credential.detach ${dropped} alice -`,
      `persona.delete ${id} alice -`,
    ].sort(),
  );
  const audit = await fetch(
    `${base}/v1/admin/audit?scope=org:default-org&action=keychain.drop.mint`,
    as(browserSessionCookie("admin-alice")),
  );
  const { events } = (await audit.json()) as { events: { principalId: string; impersonatedBy?: string }[] };
  assert.deepEqual(
    events.map((e) => [e.principalId, e.impersonatedBy]),
    [["alice", "admin-alice"]],
  );
});
