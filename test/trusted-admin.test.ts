import "./support/auto-fake-sprites.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { twoTenants } from "./support/two-tenants.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../src/auth/portal-identity.ts";
import { withTenant as inTenant } from "../src/tenants/context.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { trustedPrincipal } from "../plugins/portal/src/trusted-entry.ts";
import { provisionTrustedAdmin } from "../plugins/portal/src/trusted-admin.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { withoutTenant } from "../src/tenants/context.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

const signingSecret = "core-test-secret".repeat(3);
const identitySecret = "portal-test-secret".repeat(3);
const issuer = "https://identity.example.test";
function start(enabled = true, databaseUrl?: string) {
  const built = buildApp(
    testConfig({
      ...(databaseUrl ? { databaseUrl } : {}),
      dataDir: mkdtempSync(join(tmpdir(), "trusted-admin-")),
      orgId: "default-org",
      ...(enabled ? { trustedOidcAdminIssuer: issuer } : {}),
    }),
  );
  const server = createServer(built.app, {
    signingSecret,
    capabilitySecret: "capability-secret".repeat(3),
    portalIdentitySecret: identitySecret,
    requireSignedPortalIdentity: true,
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    admin: built.admin,
    identity: built.identity,
    auditLog: built.auditLog,
  });
  server.listen(0);
  return {
    built,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
function claims(overrides: Record<string, unknown> = {}) {
  return {
    purpose: "trusted-entry-admin",
    issuer,
    subject: "founder-7",
    org: "org:default-org",
    exp: Date.now() + 55_000,
    jti: crypto.randomUUID(),
    ...overrides,
  };
}
async function send(base: string, payload: unknown, key = identitySecret, sourceSigned = true, tenantId?: string) {
  const path = `/v1/auth/trusted/admin?nonce=${crypto.randomUUID()}`;
  const body = JSON.stringify({ assertion: await mintSignedPayload(payload, key) });
  const ts = Math.floor(Date.now() / 1000);
  const presented = tenantId
    ? {
        [PORTAL_IDENTITY_HEADER]: await mintPortalIdentity(
          { p: "operator@example.test", t: tenantId, exp: Date.now() + 60_000 },
          identitySecret,
        ),
      }
    : {};
  return fetch(base + path, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...presented,
      ...(sourceSigned
        ? { "x-timestamp": String(ts), "x-signature": signRequest(signingSecret, ts, `POST\n${path}\n${body}`) }
        : {}),
    },
  });
}

test("portal provisioning creates a durable ordinary grant once and preserves existing grants", async (t) => {
  const s = start();
  t.after(s.close);
  const config = { core: s.base, signingSecret, identitySecret, org: "default-org", issuer };
  await Promise.all(Array.from({ length: 8 }, () => provisionTrustedAdmin(config, "founder-7")));
  const principal = { id: trustedPrincipal(issuer, "founder-7"), type: "internal" as const };
  assert.equal((await s.built.admin.adminStatusOf(tenant, principal)).isAdmin, true);
  const first = await s.built.admin.listGrants(tenant);
  await provisionTrustedAdmin(config, "founder-7");
  assert.deepEqual(await s.built.admin.listGrants(tenant), first);
  assert.equal((await s.built.auditLog.events(tenant)).filter((e) => e.action === "grant.create").length, 1);
  assert.equal((await s.built.admin.adminStatusOf(tenant, { id: "founder-7", type: "internal" })).isAdmin, false);
  assert.equal(
    (await s.built.admin.adminStatusOf(tenant, { id: "founder@example.test", type: "internal" })).isAdmin,
    false,
  );
});

test("provisioning rejects forged, unrelated, expired, impersonated, and replayed assertions", async (t) => {
  const s = start();
  t.after(s.close);
  for (const invalid of [
    { purpose: "session" },
    { org: "org:other" },
    { issuer: "https://other.example.test" },
    { exp: Date.now() - 1 },
    { exp: Date.now() + 120_000 },
    { exp: null },
    { subject: "" },
    { subject: "x".repeat(256) },
    { subject: "\ud800" },
    { imp: "operator" },
    { jti: "" },
  ])
    assert.ok((await send(s.base, claims(invalid))).status >= 400, JSON.stringify(invalid));
  assert.equal((await send(s.base, claims(), signingSecret)).status, 403);
  assert.ok((await send(s.base, claims(), identitySecret, false)).status >= 400);
  assert.equal(
    (await send(s.base, { p: trustedPrincipal(issuer, "founder-7"), exp: Date.now() + 55_000 })).status,
    403,
  );
  assert.ok(!(await s.built.admin.listGrants(tenant)).some((g) => g.principalId.startsWith("oidc:")));
  const payload = claims();
  assert.equal((await send(s.base, payload)).status, 200);
  assert.equal((await send(s.base, payload)).status, 409);
});

test("provisioning needs core opt-in and never reactivates a deactivated founder", async (t) => {
  const disabled = start(false);
  t.after(disabled.close);
  assert.equal((await send(disabled.base, claims())).status, 403);
  const s = start();
  t.after(s.close);
  const id = trustedPrincipal(issuer, "founder-7");
  await s.built.identity.deactivate(id);
  assert.equal((await send(s.base, claims())).status, 403);
  assert.equal((await s.built.admin.adminStatusOf(tenant, { id, type: "internal" })).isAdmin, false);
});

test("on a shared host with no tenant bound, a trusted sign-in grants admin nowhere", async (t) => {
  await bindBootTenant(async () => undefined);
  t.after(() => bindBootTenant(async () => TEST_TENANT));
  const s = withoutTenant(() => start());
  t.after(s.close);
  const before = await s.built.admin.listGrants(tenant);
  const response = await withoutTenant(() => send(s.base, claims({ subject: "founder-shared" })));
  assert.equal(response.status, 204);
  assert.deepEqual(await s.built.admin.listGrants(tenant), before);
  const principal = { id: trustedPrincipal(issuer, "founder-shared"), type: "internal" as const };
  assert.equal((await s.built.admin.adminStatusOf(tenant, principal)).isAdmin, false);
  const config = { core: s.base, signingSecret, identitySecret, org: "default-org", issuer };
  await withoutTenant(() => provisionTrustedAdmin(config, "founder-shared"));
  assert.deepEqual(await s.built.admin.listGrants(tenant), before);
});

test("on a shared host, trusted sign-in grants admin only in a tenant the subject belongs to", async (t) => {
  await bindBootTenant(async () => undefined);
  t.after(() => bindBootTenant(async () => TEST_TENANT));
  const db = await twoTenants();
  t.after(() => db.close());
  const [alpha, beta] = db.tenants;
  const s = withoutTenant(() => start(true, db.appDatabaseUrl));
  t.after(s.close);
  const id = trustedPrincipal(issuer, "founder-alpha");
  await inTenant(alpha, (token) => s.built.admin.users.record(token, { id, source: "invite", at: Date.now() }));
  const isAdmin = async (tenantId: string) =>
    (await inTenant(tenantId, (token) => s.built.admin.adminStatusOf(token, { id, type: "internal" }))).isAdmin;
  const presentTo = (tenantId: string) =>
    withoutTenant(() => send(s.base, claims({ subject: "founder-alpha" }), identitySecret, true, tenantId));

  assert.equal((await presentTo(beta)).status, 403);
  assert.equal(await isAdmin(beta), false);
  assert.equal((await presentTo(alpha)).status, 200);
  assert.equal(await isAdmin(alpha), true);
  assert.equal((await presentTo(beta)).status, 403, "an admin grant in one tenant is not membership in another");
  assert.equal(await isAdmin(beta), false);
});

test("with a boot tenant, trusted sign-in still bootstraps the boot tenant but not another tenant", async (t) => {
  const db = await twoTenants();
  t.after(() => db.close());
  const [other] = db.tenants;
  const s = start(true, db.appDatabaseUrl);
  t.after(s.close);
  const id = trustedPrincipal(issuer, "founder-boot");
  const isAdmin = async (tenantId: string) =>
    (await inTenant(tenantId, (token) => s.built.admin.adminStatusOf(token, { id, type: "internal" }))).isAdmin;
  assert.equal((await send(s.base, claims({ subject: "founder-boot" }), identitySecret, true, other)).status, 403);
  assert.equal(await isAdmin(other), false);
  assert.equal((await send(s.base, claims({ subject: "founder-boot" }))).status, 200);
  assert.equal(await isAdmin(TEST_TENANT), true);
});
