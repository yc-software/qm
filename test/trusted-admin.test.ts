import "./support/auto-fake-sprites.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { configuredTenant, inResolvedTenant, setTenantResolver } from "../plugins/chassis/src/resolve-tenant.ts";
import { withTenant } from "../src/tenants/context.ts";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { trustedPrincipal } from "../plugins/portal/src/trusted-entry.ts";
import { provisionTrustedAdmin } from "../plugins/portal/src/trusted-admin.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { canonicalPayload } from "../plugins/chassis/src/source-auth-sign.ts";
import { inTestTenant, testTenantHeaders, testTenants } from "./support/test-tenants.ts";

const signingSecret = "core-test-secret".repeat(3);
const identitySecret = "portal-test-secret".repeat(3);
const issuer = "https://identity.example.test";
function start(enabled = true) {
  const built = buildApp(
    testConfig({
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
    tenant: testTenants()[0],
    purpose: "trusted-entry-admin",
    issuer,
    subject: "founder-7",
    org: "org:default-org",
    exp: Date.now() + 55_000,
    jti: crypto.randomUUID(),
    ...overrides,
  };
}
async function send(base: string, payload: unknown, key = identitySecret, sourceSigned = true) {
  const path = `/v1/auth/trusted/admin?nonce=${crypto.randomUUID()}`;
  const body = JSON.stringify({ assertion: await mintSignedPayload(payload, key) });
  const ts = Math.floor(Date.now() / 1000);
  return fetch(base + path, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      ...testTenantHeaders(),
      ...(sourceSigned
        ? {
            "x-timestamp": String(ts),
            "x-signature": signRequest(signingSecret, ts, canonicalPayload("POST", path, body, testTenants()[0])),
          }
        : {}),
    },
  });
}

test("a portal bound to its tenant provisions a durable ordinary grant there once and preserves existing grants", async (t) => {
  const s = start();
  t.after(s.close);
  const config = { core: s.base, signingSecret, identitySecret, org: "default-org", issuer };
  await inTestTenant(() => Promise.all(Array.from({ length: 8 }, () => provisionTrustedAdmin(config, "founder-7"))));
  const principal = { id: trustedPrincipal(issuer, "founder-7"), type: "internal" as const };
  assert.equal((await inTestTenant(() => s.built.admin.adminStatusOf(principal))).isAdmin, true);
  const first = await inTestTenant(() => s.built.admin.listGrants());
  await inTestTenant(() => provisionTrustedAdmin(config, "founder-7"));
  assert.deepEqual(await inTestTenant(() => s.built.admin.listGrants()), first);
  assert.equal(
    (await inTestTenant(() => s.built.auditLog.events())).filter((e) => e.action === "grant.create").length,
    1,
  );
  assert.equal(
    (await inTestTenant(() => s.built.admin.adminStatusOf({ id: "founder-7", type: "internal" }))).isAdmin,
    false,
  );
  assert.equal(
    (await inTestTenant(() => s.built.admin.adminStatusOf({ id: "founder@example.test", type: "internal" }))).isAdmin,
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
    { tenant: testTenants()[1] },
    { tenant: undefined },
  ])
    assert.ok((await send(s.base, claims(invalid))).status >= 400, JSON.stringify(invalid));
  assert.equal((await send(s.base, claims(), signingSecret)).status, 403);
  assert.ok((await send(s.base, claims(), identitySecret, false)).status >= 400);
  assert.equal(
    (await send(s.base, { p: trustedPrincipal(issuer, "founder-7"), exp: Date.now() + 55_000 })).status,
    403,
  );
  assert.ok(!(await inTestTenant(() => s.built.admin.listGrants())).some((g) => g.principalId.startsWith("oidc:")));
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
  await inTestTenant(() => s.built.identity.deactivate(id));
  assert.equal((await send(s.base, claims())).status, 403);
  assert.equal((await inTestTenant(() => s.built.admin.adminStatusOf({ id, type: "internal" }))).isAdmin, false);
});

test("a portal provisions admins only in its configured tenant, refuses without one, and core rejects a re-addressed request", async (t) => {
  const s = start();
  t.after(s.close);
  t.after(() => setTenantResolver(configuredTenant(undefined)));
  const config = { core: s.base, signingSecret, identitySecret, org: "default-org", issuer };
  const edge = createHttpServer(
    (req, res) =>
      void inResolvedTenant(req, res, async () => {
        await provisionTrustedAdmin(config, String(req.headers["x-subject"]));
        res.end("ok");
      }),
  );
  edge.listen(0);
  t.after(() => edge.close());
  const viaEdge = (subject: string) =>
    fetch(`http://127.0.0.1:${(edge.address() as AddressInfo).port}/`, { headers: { "x-subject": subject } });
  const isAdmin = (tenant: string, subject: string) =>
    withTenant(tenant, async () => {
      const principal = { id: trustedPrincipal(issuer, subject), type: "internal" as const };
      return (await s.built.admin.adminStatusOf(principal)).isAdmin;
    });
  const [a, b] = testTenants();
  for (const [tenant, other, subject] of [
    [a, b, "founder-a"],
    [b, a, "founder-b"],
  ] as const) {
    setTenantResolver(configuredTenant(tenant));
    assert.equal((await viaEdge(subject)).status, 200);
    assert.equal(await isAdmin(tenant, subject), true);
    assert.equal(await isAdmin(other, subject), false);
  }
  for (const missing of [undefined, "", "not-a-tenant"]) {
    setTenantResolver(configuredTenant(missing));
    assert.equal((await viaEdge("founder-none")).status, 503);
  }
  assert.equal(await isAdmin(a, "founder-none"), false);
  const path = `/v1/auth/trusted/admin?nonce=${crypto.randomUUID()}`;
  const body = JSON.stringify({ assertion: await mintSignedPayload(claims({ subject: "founder-x" }), identitySecret) });
  const ts = Math.floor(Date.now() / 1000);
  const readdressed = await fetch(s.base + path, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-qm-tenant": b,
      "x-timestamp": String(ts),
      "x-signature": signRequest(signingSecret, ts, canonicalPayload("POST", path, body, a)),
    },
  });
  assert.equal(readdressed.status, 401);
  assert.equal(await isAdmin(b, "founder-x"), false);
});
