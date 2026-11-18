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
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { trustedPrincipal } from "../plugins/portal/src/trusted-entry.ts";
import { selfServeWorkspace } from "../plugins/portal/src/trusted-admin.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";
import { APP_HANDLE_MAX } from "../plugins/chassis/src/dns-label.ts";

const signingSecret = "core-test-secret".repeat(3);
const identitySecret = "portal-test-secret".repeat(3);
const issuer = "https://identity.example.test";

function start(databaseUrl: string, enabled = true) {
  const built = buildApp(
    testConfig({
      databaseUrl,
      dataDir: mkdtempSync(join(tmpdir(), "self-serve-")),
      orgId: "default-org",
      ...(enabled ? { trustedOidcSelfServeIssuer: issuer } : {}),
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
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    built,
    base,
    config: { core: base, signingSecret, identitySecret, org: "default-org", issuer },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    purpose: "trusted-self-serve",
    issuer,
    subject: "founder-1",
    email: null,
    externalOrg: { id: "42", name: "Acme Robotics", handle: "acme" },
    org: "org:default-org",
    exp: Date.now() + 55_000,
    jti: crypto.randomUUID(),
    ...overrides,
  };
}

async function send(base: string, payload: unknown, key = identitySecret) {
  const path = `/v1/auth/broker/self-serve?nonce=${crypto.randomUUID()}`;
  const body = JSON.stringify({ assertion: await mintSignedPayload(payload, key) });
  const ts = Math.floor(Date.now() / 1000);
  return fetch(base + path, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-timestamp": String(ts),
      "x-signature": signRequest(signingSecret, ts, `POST\n${path}\n${body}`),
    },
  });
}

async function shared(t: test.TestContext) {
  await bindBootTenant(async () => undefined);
  t.after(() => bindBootTenant(async () => TEST_TENANT));
  const db = await twoTenants();
  t.after(() => db.close());
  const s = withoutTenant(() => start(db.appDatabaseUrl));
  t.after(s.close);
  const directory = createPostgresDirectoryStore(db.appDatabaseUrl);
  const isAdmin = (tenant: string, subject: string) =>
    withTenant(tenant, async (token) => {
      const id = trustedPrincipal(issuer, subject);
      return (await s.built.admin.adminStatusOf(token, { id, type: "internal" })).isAdmin;
    });
  return { db, s, directory, isAdmin };
}

test("cofounders signing in at once share one new workspace and every one of them is an admin", async (t) => {
  const { db, s, directory, isAdmin } = await shared(t);
  const founders = ["founder-1", "founder-2", "founder-3", "founder-4"];
  const tenants = await withoutTenant(() =>
    Promise.all(
      founders.map((subject, i) =>
        selfServeWorkspace(
          s.config,
          { subject, email: `f${i}@acme.test` },
          { id: "42", name: "Acme Robotics", handle: "acme" },
        ),
      ),
    ),
  );
  assert.equal(new Set(tenants).size, 1);
  const [tenant] = tenants as [string];
  const [row] = await db.owner.q("SELECT settings FROM tenants WHERE id = $1", [tenant]);
  assert.deepEqual(row?.settings, { brandName: "Acme Robotics", handle: "acme" });
  for (const subject of founders) assert.equal(await isAdmin(tenant, subject), true, subject);
  await withoutTenant(async () => {
    assert.deepEqual(await directory.tenantsForPrincipal!(trustedPrincipal(issuer, "founder-2")), [
      { id: tenant, brandName: "Acme Robotics", handle: "acme" },
    ]);
    assert.deepEqual(await directory.tenantsForEmail!("f3@acme.test"), [
      { id: tenant, brandName: "Acme Robotics", handle: "acme" },
    ]);
  });
  const events = await withTenant(tenant, (token) => s.built.auditLog.events(token));
  assert.equal(events.filter((e) => e.action === "tenant.self_serve.create").length, 1);
  assert.equal(events.filter((e) => e.action === "grant.create").length, founders.length);
  const again = await withoutTenant(() =>
    selfServeWorkspace(s.config, { subject: "founder-1", email: null }, { id: "42", name: "Renamed" }),
  );
  assert.equal(again, tenant);
  assert.deepEqual((await db.owner.q("SELECT count(*)::int AS n FROM tenant_external_orgs WHERE org_id = '42'"))[0], {
    n: 1,
  });
  assert.deepEqual(await db.app.q("SELECT * FROM tenant_external_orgs"), [], "the app login cannot read the mapping");
});

test("a workspace handle comes from the provider's handle, made valid and unique, and never blocks sign-in", async (t) => {
  const { db, s } = await shared(t);
  const [alpha] = db.tenants;
  await db.owner.q(`UPDATE tenants SET settings = '{"handle":"acmeai"}' WHERE id = $1`, [alpha]);
  const create = (id: string, handle?: string) =>
    withoutTenant(() =>
      selfServeWorkspace(
        s.config,
        { subject: `s-${id}`, email: null },
        { id, name: `Org ${id}`, ...(handle === undefined ? {} : { handle }) },
      ),
    );
  const handleOf = async (tenant: string) =>
    (await db.owner.q("SELECT settings->>'handle' AS h FROM tenants WHERE id = $1", [tenant]))[0]?.h ?? null;
  assert.equal(await handleOf(await create("a", "acme-ai")), "acmeai2");
  assert.equal(await handleOf(await create("b", "Acme AI!")), "acmeai3");
  assert.equal(await handleOf(await create("c", "admin")), "admin2");
  assert.equal(await handleOf(await create("d", "x")), "x2");
  const long = "y".repeat(APP_HANDLE_MAX + 5);
  assert.equal(await handleOf(await create("e", long)), "y".repeat(APP_HANDLE_MAX));
  assert.equal(await handleOf(await create("f", long)), `${"y".repeat(APP_HANDLE_MAX - 1)}2`);
  assert.equal(await handleOf(await create("g", "---")), null);
  assert.equal(await handleOf(await create("h")), null);
  await db.owner.q("INSERT INTO tenant_external_orgs(issuer, org_id, tenant) VALUES ('https://other.test', 'i', $1)", [
    alpha,
  ]);
  assert.notEqual(await create("i"), alpha);
});

test("self-serve rejects forged, unrelated, expired and replayed assertions, and is off unless configured", async (t) => {
  const { db, s } = await shared(t);
  for (const invalid of [
    { purpose: "trusted-entry-admin" },
    { org: "org:other" },
    { issuer: "https://other.example.test" },
    { exp: Date.now() - 1 },
    { exp: Date.now() + 120_000 },
    { subject: "" },
    { imp: "operator" },
    { email: "not-an-email" },
    { externalOrg: { id: "", name: "x" } },
    { externalOrg: { id: "1", name: " " } },
    { externalOrg: undefined },
    { jti: "" },
  ])
    assert.ok((await withoutTenant(() => send(s.base, claims(invalid)))).status >= 400, JSON.stringify(invalid));
  assert.equal((await withoutTenant(() => send(s.base, claims(), signingSecret))).status, 403);
  const payload = claims();
  assert.equal((await withoutTenant(() => send(s.base, payload))).status, 200);
  assert.equal((await withoutTenant(() => send(s.base, payload))).status, 409);
  const off = withoutTenant(() => start(db.appDatabaseUrl, false));
  t.after(off.close);
  assert.equal(
    (await withoutTenant(() => send(off.base, claims({ externalOrg: { id: "9", name: "Off" } })))).status,
    403,
  );
  assert.deepEqual((await db.owner.q("SELECT count(*)::int AS n FROM tenant_external_orgs WHERE org_id = '9'"))[0], {
    n: 0,
  });
});

test("a founder removed from the workspace cannot self-serve back in", async (t) => {
  const { s, isAdmin } = await shared(t);
  const org = { id: "77", name: "Leavers Inc" };
  const tenant = await withoutTenant(() => selfServeWorkspace(s.config, { subject: "stayer", email: null }, org));
  const leaver = trustedPrincipal(issuer, "leaver");
  await withTenant(tenant, async () => {
    await s.built.admin.users.record({ id: leaver, source: "invite", at: Date.now() });
    await s.built.admin.users.markOffboarded(leaver, trustedPrincipal(issuer, "stayer"));
  });
  await assert.rejects(
    withoutTenant(() => selfServeWorkspace(s.config, { subject: "leaver", email: null }, org)),
    /HTTP 403/,
  );
  assert.equal(await isAdmin(tenant, "leaver"), false);
});

test("a deployment with a boot tenant never self-serves another workspace", async (t) => {
  const db = await twoTenants();
  t.after(() => db.close());
  const s = start(db.appDatabaseUrl);
  t.after(s.close);
  assert.equal((await send(s.base, claims({ externalOrg: { id: "boot", name: "Boot" } }))).status, 403);
});
