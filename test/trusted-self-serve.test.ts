import "./support/auto-fake-sprites.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
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
import { provisionerSigningKey } from "../src/tenants/self-serve.ts";
import { orgId } from "../src/config.ts";
import { scopeId } from "../src/types.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";

const signingSecret = "core-test-secret".repeat(3);
const identitySecret = "portal-test-secret".repeat(3);
const issuer = "https://identity.example.test";

function start(databaseUrl: string, workspaceProvisionerUrl?: string, enabled = true) {
  const built = buildApp(
    testConfig({
      databaseUrl,
      dataDir: mkdtempSync(join(tmpdir(), "self-serve-")),
      orgId: "default-org",
      signingSecret,
      ...(workspaceProvisionerUrl ? { workspaceProvisionerUrl } : {}),
    }),
  );
  const server = createServer(built.app, {
    signingSecret,
    capabilitySecret: "capability-secret".repeat(3),
    ...(enabled ? { portalIdentitySecret: identitySecret, requireSignedPortalIdentity: true } : {}),
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    admin: built.admin,
    ...(built.selfServe ? { selfServe: built.selfServe } : {}),
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
    externalOrg: { id: "42", name: "Acme Robotics" },
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

function provisioner(t: test.TestContext) {
  const state = {
    failing: false,
    reply: { settings: { modelGatewayKey: "own-key" } } as unknown,
    calls: [] as Array<{ body: Record<string, unknown>; signed: boolean }>,
  };
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const ts = Number(req.headers["x-timestamp"]);
      const key = provisionerSigningKey(signingSecret);
      const signed = req.headers["x-signature"] === signRequest(key, ts, `POST\n${req.url}\n${raw}`);
      state.calls.push({ body: JSON.parse(raw) as Record<string, unknown>, signed });
      res.writeHead(state.failing ? 500 : 200, { "content-type": "application/json" });
      res.end(state.failing ? "{}" : JSON.stringify(state.reply));
    });
  });
  server.listen(0);
  t.after(() => server.close());
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/provision?x=1` };
}

async function shared(t: test.TestContext) {
  await bindBootTenant(async () => undefined);
  t.after(() => bindBootTenant(async () => TEST_TENANT));
  const db = await twoTenants();
  t.after(() => db.close());
  const provision = provisioner(t);
  const s = withoutTenant(() => start(db.appDatabaseUrl, provision.url));
  t.after(s.close);
  const directory = createPostgresDirectoryStore(db.appDatabaseUrl);
  const isAdmin = (tenant: string, subject: string) =>
    withTenant(tenant, async (token) => {
      const id = trustedPrincipal(issuer, subject);
      return (await s.built.admin.adminStatusOf(token, { id, type: "internal" })).isAdmin;
    });
  return { db, s, directory, isAdmin, provision };
}

test("cofounders signing in at once share one new workspace and every one of them is an admin", async (t) => {
  const { db, s, directory, isAdmin } = await shared(t);
  const founders = ["founder-1", "founder-2", "founder-3", "founder-4"];
  const tenants = await withoutTenant(() =>
    Promise.all(
      founders.map((subject, i) =>
        selfServeWorkspace(s.config, { subject, email: `f${i}@acme.test` }, { id: "42", name: "Acme Robotics" }),
      ),
    ),
  );
  assert.equal(new Set(tenants).size, 1);
  const [tenant] = tenants as [string];
  const [row] = await db.owner.q("SELECT settings FROM tenants WHERE id = $1", [tenant]);
  assert.deepEqual(row?.settings, {
    brandName: "Acme Robotics",
    modelGatewayKey: "own-key",
    serving: true,
    deploymentModelKey: false,
  });
  for (const subject of founders) assert.equal(await isAdmin(tenant, subject), true, subject);
  await withoutTenant(async () => {
    assert.deepEqual(await directory.tenantsForPrincipal!(trustedPrincipal(issuer, "founder-2")), [
      { id: tenant, brandName: "Acme Robotics" },
    ]);
    assert.deepEqual(await directory.tenantsForEmail!("f3@acme.test"), [{ id: tenant, brandName: "Acme Robotics" }]);
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

test("self-serve rejects forged, unrelated, expired and replayed assertions, and is off without a portal identity secret", async (t) => {
  const { db, s } = await shared(t);
  for (const invalid of [
    { purpose: "trusted-entry-admin" },
    { org: "org:other" },
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
  const off = withoutTenant(() => start(db.appDatabaseUrl, undefined, false));
  t.after(off.close);
  const noProvisioner = withoutTenant(() => start(db.appDatabaseUrl));
  t.after(noProvisioner.close);
  const offered = async (base: string) => {
    const path = withSourceAuthNonce("/v1/auth/broker/principal-tenants?principal=nobody", signingSecret);
    const body = (await (await fetch(base + path, { headers: signedHeaders(signingSecret, "GET", path) })).json()) as {
      selfServe?: boolean;
    };
    return body.selfServe;
  };
  assert.deepEqual(
    await withoutTenant(async () => [
      await offered(s.base),
      await offered(off.base),
      await offered(noProvisioner.base),
    ]),
    [true, undefined, undefined],
  );
  const statusOf = async (base: string, id: string) =>
    (await withoutTenant(() => send(base, claims({ externalOrg: { id, name: "Off" } })))).status;
  assert.deepEqual([await statusOf(off.base, "9"), await statusOf(noProvisioner.base, "10")], [503, 403]);
  assert.deepEqual(
    (await db.owner.q("SELECT count(*)::int AS n FROM tenant_external_orgs WHERE org_id IN ('9', '10')"))[0],
    { n: 0 },
  );
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

test("a member an admin demoted does not regain admin by self-serving again", async (t) => {
  const { s, isAdmin } = await shared(t);
  const org = { id: "78", name: "Demoted Inc" };
  const signIn = (subject: string) => withoutTenant(() => selfServeWorkspace(s.config, { subject, email: null }, org));
  const tenant = await signIn("keeper");
  await signIn("demoted");
  await withTenant(tenant, async (bound) => {
    const actor = { id: trustedPrincipal(issuer, "keeper"), type: "internal" as const };
    await s.built.admin.revokeGrant(
      bound,
      actor,
      trustedPrincipal(issuer, "demoted"),
      scopeId("org", orgId()),
      "org_admin",
    );
  });
  assert.equal(await isAdmin(tenant, "demoted"), false);
  assert.equal(await signIn("demoted"), tenant);
  assert.equal(await isAdmin(tenant, "demoted"), false);
});

test("a deployment with a boot tenant never self-serves another workspace", async (t) => {
  const db = await twoTenants();
  t.after(() => db.close());
  const s = start(db.appDatabaseUrl, provisioner(t).url);
  t.after(s.close);
  assert.equal((await send(s.base, claims({ externalOrg: { id: "boot", name: "Boot" } }))).status, 403);
});

test("a deployment's provisioner sets up each new workspace before anyone can use it, and a failure leaves it switched off", async (t) => {
  const { db, s, directory, isAdmin, provision } = await shared(t);
  provision.state.failing = true;
  const org = { id: "55", name: "Gated Co", partnerChatAccount: "5555" };
  const signIn = (subject: string) => withoutTenant(() => selfServeWorkspace(s.config, { subject, email: null }, org));
  await assert.rejects(signIn("g1"), /HTTP 502/);
  const [row] = await db.owner.q("SELECT tenant::text AS tenant FROM tenant_external_orgs WHERE org_id = '55'");
  const tenant = row!.tenant as string;
  const settingsOf = async () =>
    (await db.owner.q("SELECT settings FROM tenants WHERE id = $1", [tenant]))[0]?.settings;
  assert.deepEqual(await settingsOf(), {
    brandName: "Gated Co",
    serving: false,
    deploymentModelKey: false,
  });
  assert.deepEqual(await withoutTenant(() => directory.tenantsForPrincipal!(trustedPrincipal(issuer, "g1"))), []);
  assert.equal(await isAdmin(tenant, "g1"), false);
  provision.state.failing = false;
  assert.deepEqual(await Promise.all([signIn("g1"), signIn("g2")]), [tenant, tenant]);
  assert.deepEqual(await settingsOf(), {
    brandName: "Gated Co",
    modelGatewayKey: "own-key",
    serving: true,
    deploymentModelKey: false,
  });
  const { nonce, ...body } = provision.state.calls[0]!.body;
  assert.equal(typeof nonce, "string");
  assert.deepEqual(body, { tenant, brandName: "Gated Co", issuer, externalOrg: org });
  assert.ok(provision.state.calls.every((call) => call.signed));
  const calls = provision.state.calls.length;
  await signIn("g3");
  assert.equal(provision.state.calls.length, calls, "a provisioned workspace is not provisioned again");
  for (const subject of ["g1", "g2", "g3"]) assert.equal(await isAdmin(tenant, subject), true, subject);
  await db.owner.q(`UPDATE tenants SET settings = settings || '{"serving":false}' WHERE id = $1`, [tenant]);
  await assert.rejects(signIn("g4"), /HTTP 503/);
  assert.equal(provision.state.calls.length, calls, "a workspace an operator switched off is not switched back on");
  assert.equal(await isAdmin(tenant, "g4"), false);
  await db.owner.q(`UPDATE tenants SET settings = settings - 'modelGatewayKey' WHERE id = $1`, [tenant]);
  await assert.rejects(signIn("g4"), /HTTP 503/);
  assert.equal(provision.state.calls.length, calls, "removing the key does not reopen a switched-off workspace");
});

test("a provisioner reply without the workspace's own model gateway key leaves it switched off", async (t) => {
  const { s, isAdmin, provision, db } = await shared(t);
  provision.state.reply = { settings: { brandName: "Renamed" } };
  const org = { id: "66", name: "No Key Co" };
  await assert.rejects(
    withoutTenant(() => selfServeWorkspace(s.config, { subject: "n1", email: null }, org)),
    /HTTP 502/,
  );
  const [row] = await db.owner.q(
    "SELECT t.settings FROM tenant_external_orgs o JOIN tenants t ON t.id = o.tenant WHERE o.org_id = '66'",
  );
  assert.deepEqual(row, { settings: { brandName: "No Key Co", serving: false, deploymentModelKey: false } });
  assert.equal(
    await isAdmin(
      String((await db.owner.q("SELECT tenant FROM tenant_external_orgs WHERE org_id = '66'"))[0]!.tenant),
      "n1",
    ),
    false,
  );
});

test("self-serve never creates a deployment's first workspace", async (t) => {
  await bindBootTenant(async () => undefined);
  t.after(() => bindBootTenant(async () => TEST_TENANT));
  const db = await twoTenants();
  t.after(() => db.close());
  const s = withoutTenant(() => start(db.appDatabaseUrl, provisioner(t).url));
  t.after(s.close);
  await db.owner.q("DELETE FROM tenants");
  assert.equal(
    (await withoutTenant(() => send(s.base, claims({ externalOrg: { id: "first", name: "First" } })))).status,
    403,
  );
  assert.deepEqual((await db.owner.q("SELECT count(*)::int AS n FROM tenants"))[0], { n: 0 });
});
