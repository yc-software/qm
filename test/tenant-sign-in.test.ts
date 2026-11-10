import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { orgId } from "../src/config.ts";
import { withRequestTenant } from "../src/api/request-tenant.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { createPostgresUserStore } from "../src/identity/user-store.ts";
import type { DirectoryStore } from "../src/directory/directory-store.ts";
import type { IdentityService } from "../src/identity/identity-service.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { boundTenant, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { appUrl, ownerUrl, testTenant } from "./support/test-tenant.ts";

const IDENTITY_SECRET = "tenant-sign-in-identity-secret".repeat(2);
const alpha = randomUUID();
const beta = randomUUID();
const copied = randomUUID();
const databaseUrl = testMigratedDatabaseUrl();
const owner = createPgPool(ownerUrl(databaseUrl).toString());
const directory = createPostgresDirectoryStore(appUrl(databaseUrl));
const users = createPostgresUserStore(appUrl(databaseUrl));

const signIn = (tenant: string, alias: string, person: string) =>
  withTenant(tenant, () =>
    users.link({ principalId: alias, canonicalId: person, evidence: "sso", linkedBy: "", createdAt: 0 }),
  );

async function member(tenant: string, principal: string, type = "internal"): Promise<void> {
  await owner.q(
    `INSERT INTO directory_members(tenant_id, org_id, principal_id, display_name, display_name_lc, type)
     VALUES ($1, $2, $3, $3, lower($3), $4)`,
    [tenant, orgId(), principal, type],
  );
}

test.before(async () => {
  await bindBootTenant(async () => undefined);
  await directory.list(testTenant).catch(() => undefined);
  await owner.q(
    `INSERT INTO tenants(id, settings) VALUES
       ($1, '{"brandName":"Alpha","allowedEmails":["@nowhere.test"]}'),
       ($2, '{"serving":true}'),
       ($3, '{"brandName":"Copied","orgSlug":"copied-co","serving":false}')`,
    [alpha, beta, copied],
  );
  await member(copied, "alice@alpha.test");
  await member(alpha, "alice@alpha.test");
  await member(beta, "bob@beta.test");
  await member(alpha, "both@shared.test");
  await member(beta, "Both@Shared.test");
  await member(beta, "guest@alpha.test", "guest");
  await member(beta, "carol@elsewhere.test");
  await member(alpha, "dan@elsewhere.test");
});

test.after(() => owner.close());

test("an email maps to the serving tenants whose directory lists it, readable by the RLS-bound app login", () =>
  withoutTenant(async () => {
    assert.deepEqual(await directory.tenantsForEmail!("alice@alpha.test"), [{ id: alpha, brandName: "Alpha" }]);
    assert.deepEqual(await directory.tenantsForEmail!("bob@beta.test"), [{ id: beta }]);
    const both = await directory.tenantsForEmail!("BOTH@shared.test");
    assert.deepEqual(both.map(({ id }) => id).sort(), [alpha, beta].sort());
    assert.deepEqual(await directory.tenantsForEmail!("guest@alpha.test"), []);
    assert.deepEqual(await directory.tenantsForEmail!("nobody@nowhere.test"), []);
    await signIn(copied, "oidc:issuer:alice", "alice@alpha.test");
    assert.deepEqual(await directory.tenantsForPrincipal!("oidc:issuer:alice"), []);
    const app = createPgPool(appUrl(databaseUrl));
    try {
      await assert.rejects(app.q("SELECT principal_id FROM directory_members"), /No tenant is bound/);
    } finally {
      await app.close();
    }
  }));

function identityAdmitting(tenant: string | undefined, seen: Array<string | undefined>): IdentityService {
  return {
    refresh: async () => undefined,
    deactivationSource: () => undefined,
    externalMember: () => undefined,
    classify: () => {
      seen.push(boundTenant());
      return { type: tenant === undefined || boundTenant() === tenant ? "internal" : "guest" };
    },
  } as unknown as IdentityService;
}

function start(
  identity: IdentityService,
  tenants: DirectoryStore["tenantsForEmail"],
  requireSignedPortalIdentity = false,
) {
  const built = buildApp(
    testConfig({ databaseUrl, dataDir: mkdtempSync(join(tmpdir(), "tenant-sign-in-")), orgId: "acme" }),
  );
  const server = createInsecureTestServer(built.app, {
    portalIdentitySecret: IDENTITY_SECRET,
    identity,
    users,
    requireSignedPortalIdentity,
    emailAuthDomain: "shared.test",
    deployAppsDomain: "apps.shared.test",
    directory: {
      tenantsForEmail: tenants,
      tenantsForPrincipal: (principal: string) => directory.tenantsForPrincipal!(principal),
      tenantForAppHandle: (handle: string) => directory.tenantForAppHandle!(handle),
      trustedClientFor: (tenant: string) => directory.trustedClientFor!(tenant),
    } as unknown as DirectoryStore,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    get: async (path: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}${path}`, { headers });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    post: async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a company admin or user is found by email or sign-in principal, directly or through a sign-in link, with no directory row", () =>
  withoutTenant(async () => {
    const grant = (tenant: string, principal: string) =>
      owner.q(
        `INSERT INTO admin_grants(tenant_id, principal_id, scope_id, role) VALUES ($1, $2, 'org:x', 'org_admin')`,
        [tenant, principal],
      );
    await grant(alpha, "Founder@Copied.test");
    await grant(beta, "oidc:issuer:direct");
    await grant(beta, "linked@copied.test");
    await signIn(beta, "oidc:issuer:linked", "linked@copied.test");
    await signIn(alpha, "oidc:issuer:elsewhere", "linked@copied.test");
    await signIn(beta, "oidc:issuer:user", "user@copied.test");
    await signIn(alpha, "oidc:issuer:leaver", "leaver@copied.test");
    await withTenant(alpha, () => users.markOffboarded("leaver@copied.test", "linked@copied.test"));
    try {
      assert.deepEqual(await directory.tenantsForEmail!("founder@copied.test"), [{ id: alpha, brandName: "Alpha" }]);
      assert.deepEqual(await directory.tenantsForEmail!("User@Copied.test"), [{ id: beta }]);
      assert.deepEqual(await directory.tenantsForEmail!("leaver@copied.test"), []);
      assert.deepEqual(await directory.tenantsForPrincipal!("oidc:issuer:direct"), [{ id: beta }]);
      assert.deepEqual(await directory.tenantsForPrincipal!("oidc:issuer:linked"), [{ id: beta }]);
      assert.deepEqual(await directory.tenantsForPrincipal!("oidc:issuer:elsewhere"), [
        { id: alpha, brandName: "Alpha" },
      ]);
      assert.deepEqual(await directory.tenantsForPrincipal!("oidc:issuer:user"), [{ id: beta }]);
      assert.deepEqual(await directory.tenantsForPrincipal!("oidc:issuer:leaver"), []);
      assert.deepEqual(await directory.tenantsForPrincipal!("oidc:issuer:stranger"), []);
    } finally {
      await owner.q(`DELETE FROM admin_grants WHERE scope_id = 'org:x'`);
      await owner.q(`DELETE FROM users WHERE primary_alias LIKE '%@copied.test'`);
    }
  }));

test("on a host with two tenants the broker finds an email's tenants and admits it under the one that lists it", (t) =>
  withoutTenant(async () => {
    const seen: Array<string | undefined> = [];
    const srv = start(identityAdmitting(beta, seen), async () => [{ id: alpha }, { id: beta }]);
    t.after(srv.close);
    const email = "both%40shared.test";
    assert.deepEqual(await srv.get(`/v1/auth/broker/email-tenants?email=${email}`), {
      status: 200,
      body: { tenants: [{ id: alpha }, { id: beta }], shared: true },
    });
    assert.deepEqual((await srv.get(`/v1/auth/broker/email-allowed?email=${email}`)).body.allowed, true);
    assert.deepEqual(seen, [alpha, beta]);
    seen.length = 0;
    const asAlpha = await mintPortalIdentity(
      { p: "both@shared.test", t: alpha, exp: Date.now() + 60_000 },
      IDENTITY_SECRET,
    );
    const refused = await srv.get(`/v1/auth/broker/email-allowed?email=${email}`, { "x-portal-identity": asAlpha });
    assert.equal(refused.body.allowed, false);
    assert.deepEqual([...new Set(seen)], [alpha]);
    const forged = await mintPortalIdentity({ p: "x", t: beta, exp: Date.now() + 60_000 }, "another-secret".repeat(4));
    assert.equal((await srv.get("/v1/sessions", { "x-portal-identity": forged })).status, 401);
  }));

async function bound(route: { auth: "source"; tenant?: "optional" }, headers: Record<string, string>) {
  const server = createHttpServer((req, res) => {
    void withRequestTenant(
      req,
      res,
      route,
      undefined,
      undefined,
      () => void res.end(JSON.stringify({ tenant: boundTenant() ?? null })),
      IDENTITY_SECRET,
    );
  });
  server.listen(0);
  try {
    const r = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/`, { headers });
    return { status: r.status, tenant: ((await r.json()) as { tenant?: string | null }).tenant ?? null };
  } finally {
    server.close();
  }
}

test("a signed-in person's portal identity binds the tenant chosen at sign-in", () =>
  withoutTenant(async () => {
    const identity = await mintPortalIdentity(
      { p: "bob@beta.test", t: beta, exp: Date.now() + 60_000 },
      IDENTITY_SECRET,
    );
    assert.deepEqual(await bound({ auth: "source" }, { "x-portal-identity": identity }), { status: 200, tenant: beta });
    assert.equal((await bound({ auth: "source" }, {})).status, 401);
    assert.deepEqual(await bound({ auth: "source", tenant: "optional" }, {}), { status: 200, tenant: null });
  }));

test("under a company the directory is the roster, its allowed-emails list admits more, and the install list does not apply", (t) =>
  withoutTenant(async () => {
    const srv = start(identityAdmitting(undefined, []), (email) => directory.tenantsForEmail!(email));
    t.after(srv.close);
    const allowed = async (tenant: string, email: string) =>
      (
        await srv.get(`/v1/auth/broker/email-allowed?email=${encodeURIComponent(email)}`, {
          "x-portal-identity": await mintPortalIdentity(
            { p: email, t: tenant, exp: Date.now() + 60_000 },
            IDENTITY_SECRET,
          ),
        })
      ).body.allowed;
    assert.equal(await allowed(alpha, "both@shared.test"), true);
    assert.equal(await allowed(alpha, "visitor@nowhere.test"), true);
    assert.equal(await allowed(alpha, "outsider@shared.test"), false);
    assert.equal(await allowed(beta, "bob@beta.test"), true);
    assert.equal(await allowed(beta, "alice@alpha.test"), false);
    assert.equal(await allowed(beta, "outsider@shared.test"), false);
  }));

test("a single-company install keeps admitting by the install list", (t) =>
  withoutTenant(async () => {
    await bindBootTenant(async () => beta);
    t.after(() => bindBootTenant(async () => undefined));
    const srv = start(identityAdmitting(undefined, []), (email) => directory.tenantsForEmail!(email));
    t.after(srv.close);
    const allowed = async (email: string) =>
      (await srv.get(`/v1/auth/broker/email-allowed?email=${encodeURIComponent(email)}`)).body.allowed;
    assert.equal(await allowed("outsider@shared.test"), true);
    assert.equal(await allowed("stranger@elsewhere.test"), false);
  }));

test("a trusted principal maps to the tenants whose sign-in links name it, through the broker route", (t) =>
  withoutTenant(async () => {
    const srv = start(identityAdmitting(undefined, []), async () => []);
    t.after(srv.close);
    await signIn(alpha, "oidc:issuer:both", "both@shared.test");
    await signIn(beta, "oidc:issuer:both", "both@shared.test");
    await signIn(beta, "oidc:issuer:one", "bob@beta.test");
    const tenantsOf = async (principal: string) =>
      (await srv.get(`/v1/auth/broker/principal-tenants?principal=${encodeURIComponent(principal)}`)).body;
    const both = await tenantsOf("oidc:issuer:both");
    assert.deepEqual((both.tenants as Array<{ id: string }>).map(({ id }) => id).sort(), [alpha, beta].sort());
    assert.equal(both.shared, true);
    assert.deepEqual(await tenantsOf("oidc:issuer:one"), { tenants: [{ id: beta }], shared: true });
    assert.deepEqual(await tenantsOf("oidc:issuer:nobody"), { tenants: [], shared: true });
  }));

test("on a shared host the directory, not the install allowlist, permits email sign-in, and canonical lookups bind the session's tenant", (t) =>
  withoutTenant(async () => {
    const srv = start(identityAdmitting(undefined, []), (email) => directory.tenantsForEmail!(email));
    t.after(srv.close);
    const allowed = async (email: string) =>
      (await srv.get(`/v1/auth/broker/email-allowed?email=${encodeURIComponent(email)}`)).body.allowed;
    assert.equal(await allowed("carol@elsewhere.test"), true);
    assert.equal(await allowed("dan@elsewhere.test"), true);
    assert.equal(await allowed("stranger@elsewhere.test"), false);
    const canonical = "/v1/principals/carol%40elsewhere.test/canonical";
    assert.equal((await srv.get(canonical)).status, 401);
    const asBeta = await mintPortalIdentity(
      { p: "carol@elsewhere.test", t: beta, exp: Date.now() + 60_000 },
      IDENTITY_SECRET,
    );
    assert.equal((await srv.get(canonical, { "x-portal-identity": asBeta })).status, 200);
  }));

test("a workspace handle names exactly one company and its own trusted client, and a company hostname no longer maps", (t) =>
  withoutTenant(async () => {
    const srv = start(identityAdmitting(undefined, []), async () => []);
    t.after(srv.close);
    const handle = `ws${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await owner.q(
      `UPDATE tenants SET settings = settings || jsonb_build_object('handle', $2::text,
        'oidcClient', '{"clientId":"beta-client","clientSecret":"beta-client-secret-0123456789abcdef"}'::jsonb) WHERE id = $1`,
      [beta, handle],
    );
    t.after(() => owner.q(`UPDATE tenants SET settings = settings - 'handle' - 'oidcClient' WHERE id = $1`, [beta]));
    const workspace = async (name: string) =>
      (await srv.get(`/v1/auth/broker/workspace?handle=${encodeURIComponent(name)}`)).body;
    assert.deepEqual(await workspace(handle), {
      tenant: beta,
      trustedClient: { clientId: "beta-client", clientSecret: "beta-client-secret-0123456789abcdef" },
    });
    assert.deepEqual(await workspace(handle.toUpperCase()), await workspace(handle));
    assert.deepEqual(await workspace("nosuchworkspace"), { tenant: null });
    assert.equal((await srv.get("/v1/auth/broker/workspace")).status, 400);
    assert.deepEqual((await srv.get("/v1/auth/broker/host-tenant?host=beta.company.test")).body, { tenant: null });
    const appHost = async (host: string) => (await srv.get(`/v1/auth/broker/host-tenant?host=${host}`)).body;
    assert.deepEqual(await appHost(`${handle}-sales-dash.apps.shared.test`), { tenant: beta, app: true });
    for (const miss of [`${handle}.apps.shared.test`, `${handle}-.apps.shared.test`, `x.${handle}-a.apps.shared.test`])
      assert.deepEqual(await appHost(miss), { tenant: null }, miss);
  }));

test("the portal stores a signed-in person's name in their own tenant, and the canonical lookup returns it", (t) =>
  withoutTenant(async () => {
    const srv = start(identityAdmitting(undefined, []), async () => [], true);
    t.after(srv.close);
    const oidc = `oidc:issuer:${randomUUID().slice(0, 8)}`;
    await signIn(beta, oidc, "named@beta.test");
    const as = (p: string, tenant: string) =>
      mintPortalIdentity({ p, t: tenant, exp: Date.now() + 60_000 }, IDENTITY_SECRET);
    const canonical = `/v1/principals/${encodeURIComponent(oidc)}/canonical`;
    const before = await srv.get(canonical, { "x-portal-identity": await as(oidc, beta) });
    assert.deepEqual(before.body, {
      principalId: oidc,
      canonicalId: "named@beta.test",
    });
    const forged = await srv.post(
      "/v1/principals/profile",
      { principalId: oidc, displayName: "Mallory" },
      { "x-portal-identity": await as("someone@beta.test", beta) },
    );
    assert.equal(forged.status, 403);
    const saved = await srv.post(
      "/v1/principals/profile",
      { principalId: oidc, displayName: " Named  Founder " },
      { "x-portal-identity": await as(oidc, beta) },
    );
    assert.deepEqual(saved, { status: 200, body: { ok: true, changed: true } });
    const after = await srv.get(canonical, { "x-portal-identity": await as(oidc, beta) });
    assert.equal(after.body.displayName, "Named Founder");
    const blank = await srv.post(
      "/v1/principals/profile",
      { principalId: oidc, displayName: "" },
      { "x-portal-identity": await as(oidc, beta) },
    );
    assert.equal(blank.status, 400);
    assert.equal(await withTenant(alpha, async () => (await users.get(oidc))?.displayName), undefined);
  }));
