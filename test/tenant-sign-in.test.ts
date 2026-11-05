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
import type { DirectoryStore } from "../src/directory/directory-store.ts";
import type { IdentityService } from "../src/identity/identity-service.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { boundTenant } from "../src/tenants/context.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { appUrl, ownerUrl } from "./support/test-tenant.ts";

const IDENTITY_SECRET = "tenant-sign-in-identity-secret".repeat(2);
const alpha = randomUUID();
const beta = randomUUID();
const databaseUrl = testMigratedDatabaseUrl();
const owner = createPgPool(ownerUrl(databaseUrl).toString());
const directory = createPostgresDirectoryStore(appUrl(databaseUrl));

async function member(tenant: string, principal: string, type = "internal"): Promise<void> {
  await owner.q(
    `INSERT INTO directory_members(tenant_id, org_id, principal_id, display_name, display_name_lc, type)
     VALUES ($1, $2, $3, $3, lower($3), $4)`,
    [tenant, orgId(), principal, type],
  );
}

test.before(async () => {
  await directory.list().catch(() => undefined);
  await owner.q(`INSERT INTO tenants(id, settings) VALUES ($1, '{"brandName":"Alpha"}'), ($2, '{}')`, [alpha, beta]);
  await member(alpha, "alice@alpha.test");
  await member(beta, "bob@beta.test");
  await member(alpha, "both@shared.test");
  await member(beta, "Both@Shared.test");
  await member(beta, "guest@alpha.test", "guest");
});

test.after(() => owner.close());

test("an email maps to the tenants whose directory lists it, readable by the RLS-bound app login", async () => {
  assert.deepEqual(await directory.tenantsForEmail!("alice@alpha.test"), [{ id: alpha, brandName: "Alpha" }]);
  assert.deepEqual(await directory.tenantsForEmail!("bob@beta.test"), [{ id: beta }]);
  const both = await directory.tenantsForEmail!("BOTH@shared.test");
  assert.deepEqual(both.map(({ id }) => id).sort(), [alpha, beta].sort());
  assert.deepEqual(await directory.tenantsForEmail!("guest@alpha.test"), []);
  assert.deepEqual(await directory.tenantsForEmail!("nobody@nowhere.test"), []);
  const app = createPgPool(appUrl(databaseUrl));
  try {
    await assert.rejects(app.q("SELECT principal_id FROM directory_members"), /No tenant is bound/);
  } finally {
    await app.close();
  }
});

function identityAdmitting(tenant: string, seen: Array<string | undefined>): IdentityService {
  return {
    refresh: async () => undefined,
    deactivationSource: () => undefined,
    externalMember: () => undefined,
    classify: () => {
      seen.push(boundTenant());
      return { type: boundTenant() === tenant ? "internal" : "guest" };
    },
  } as unknown as IdentityService;
}

function start(identity: IdentityService, tenants: DirectoryStore["tenantsForEmail"]) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "tenant-sign-in-")), orgId: "acme" }));
  Object.assign(built.app, { readBootTenant: async () => undefined });
  const server = createInsecureTestServer(built.app, {
    portalIdentitySecret: IDENTITY_SECRET,
    identity,
    emailAuthDomain: "shared.test",
    directory: { tenantsForEmail: tenants } as unknown as DirectoryStore,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    get: async (path: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}${path}`, { headers });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("on a host with two tenants the broker finds an email's tenants and admits it under the one that lists it", async (t) => {
  const seen: Array<string | undefined> = [];
  const srv = start(identityAdmitting(beta, seen), async () => [{ id: alpha }, { id: beta }]);
  t.after(srv.close);
  const email = "both%40shared.test";
  assert.deepEqual(await srv.get(`/v1/auth/broker/email-tenants?email=${email}`), {
    status: 200,
    body: { tenants: [{ id: alpha }, { id: beta }] },
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
});

async function bound(route: { auth: "source"; tenant?: "optional" }, headers: Record<string, string>) {
  const server = createHttpServer((req, res) => {
    void withRequestTenant(
      req,
      res,
      route,
      undefined,
      async () => undefined,
      () => void res.end(JSON.stringify({ tenant: boundTenant() ?? null })),
      undefined,
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

test("a signed-in person's portal identity binds the tenant chosen at sign-in", async () => {
  const identity = await mintPortalIdentity({ p: "bob@beta.test", t: beta, exp: Date.now() + 60_000 }, IDENTITY_SECRET);
  assert.deepEqual(await bound({ auth: "source" }, { "x-portal-identity": identity }), { status: 200, tenant: beta });
  assert.equal((await bound({ auth: "source" }, {})).status, 401);
  assert.deepEqual(await bound({ auth: "source", tenant: "optional" }, {}), { status: 200, tenant: null });
});
