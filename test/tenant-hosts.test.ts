import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import pg from "pg";
import { withRequestTenant } from "../src/api/tenant-ingress.ts";
import { apiRoutes } from "../src/api/routes/index.ts";
import type { Route } from "../src/api/routes/route.ts";
import { CAPABILITY_HEADER } from "../src/api/contract.ts";
import { CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { createPgPool, type PgPool } from "../src/persistence/pg-pool.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { configureTenantSettings, loadedTenantSettings, tenantSetting } from "../src/tenants/settings.ts";
import { createTenancy, type Tenancy } from "../src/tenants/tenancy.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenancy tests";
const SECRET = "tenant-hosts-capability-secret-0123456789";
const claims = { actorId: "U1", scopeId: "personal:U1", aud: CONTROL_PLANE_AUD, exp: Date.now() + 60_000 };

function asRole(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

let owner: pg.Pool;
let appPool: PgPool;
let ownerPool: PgPool;
let tenancy: Tenancy;
const a = randomUUID();
const b = randomUUID();
const role = `tenant_hosts_${randomUUID().slice(0, 8)}`;

before(async () => {
  if (skip) return;
  const url = testMigratedDatabaseUrl();
  owner = new pg.Pool({ connectionString: url });
  await owner.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`);
  await owner.query("INSERT INTO tenants(id) VALUES ($1), ($2)", [a, b]);
  await owner.query(
    `CREATE TABLE host_probe(tenant_id uuid NOT NULL DEFAULT qm_bound_tenant() REFERENCES tenants(id), n int)`,
  );
  await owner.query(`GRANT SELECT ON host_probe TO ${role}`);
  await owner.query("ALTER TABLE host_probe ENABLE ROW LEVEL SECURITY");
  await owner.query(`CREATE POLICY tenant_isolation ON host_probe FOR ALL TO ${role}
    USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant())`);
  await owner.query("INSERT INTO host_probe(tenant_id, n) VALUES ($1, 1), ($2, 2)", [a, b]);
  appPool = createPgPool(asRole(url, role));
  ownerPool = createPgPool(url);
  tenancy = createTenancy(appPool, ownerPool);
  configureTenantSettings(tenancy.settings);
});

after(async () => {
  configureTenantSettings(undefined);
  await appPool?.close();
  await ownerPool?.close();
  await owner?.query(`DROP OWNED BY ${role}`);
  await owner?.query(`DROP ROLE IF EXISTS ${role}`);
  await owner?.end();
});

async function seen(
  headers: Record<string, string>,
  route: Pick<Route, "auth" | "tenant"> = { auth: "source" },
) {
  const req = new IncomingMessage(new Socket());
  req.headers = headers;
  const res = new ServerResponse(req);
  let rows: unknown;
  await withRequestTenant(req, res, route, SECRET, tenancy, async () => {
    rows = boundTenant() ? (await appPool.q("SELECT n FROM host_probe")).map((r) => r.n) : "unbound";
  });
  return rows ?? res.statusCode;
}

describe("host routing", { skip }, () => {
  it("behaves as before while no host is mapped", async () => {
    assert.deepEqual(await tenancy.hostTenant("anything.example.test"), { multi: false });
    assert.equal(await seen({ host: "anything.example.test" }), "unbound");
  });

  it("maps a host to one tenant only, and many hosts to a tenant", async () => {
    assert.equal(await tenancy.mapHost(a, "a.example.test"), "mapped");
    assert.equal(await tenancy.mapHost(a, "a.example.test"), "mapped");
    assert.equal(await tenancy.mapHost(a, "a-alias.example.test"), "mapped");
    assert.equal(await tenancy.mapHost(b, "b.example.test"), "mapped");
    assert.equal(await tenancy.mapHost(b, "a.example.test"), "taken");
    assert.equal(await tenancy.mapHost(randomUUID(), "c.example.test"), "unknown_tenant");
    assert.deepEqual(await tenancy.hosts(a), ["a-alias.example.test", "a.example.test"]);
    assert.equal(await tenancy.unmapHost(b, "a-alias.example.test"), false);
  });

  it("binds a mapped host, so each host sees only its tenant's rows", async () => {
    assert.deepEqual(await seen({ host: "a.example.test" }), [1]);
    assert.deepEqual(await seen({ host: "A.Example.Test:443" }), [1]);
    assert.deepEqual(await seen({ host: "a-alias.example.test" }), [1]);
    assert.deepEqual(await seen({ host: "b.example.test" }, { auth: "public" }), [2]);
  });

  it("refuses a credential for one tenant on another tenant's host", async () => {
    const tokenA = await withTenant(a, () => mintCapabilityToken(claims, SECRET));
    assert.deepEqual(await seen({ host: "a.example.test", [CAPABILITY_HEADER]: tokenA }), [1]);
    assert.equal(await seen({ host: "b.example.test", [CAPABILITY_HEADER]: tokenA }), 403);
    assert.equal(await seen({ host: "b.example.test", "x-qm-tenant": a }), 403);
  });

  it("refuses an unknown host once hosts are mapped, but lets verified credentials and probes through", async () => {
    assert.equal(await seen({ host: "stranger.example.test" }), 421);
    assert.equal(await seen({ host: "stranger.example.test" }, { auth: "public" }), 421);
    assert.equal(await seen({ host: "10.0.0.7:8080" }, { auth: "public", tenant: "none" }), "unbound");
    const tokenB = await withTenant(b, () => mintCapabilityToken(claims, SECRET));
    assert.deepEqual(await seen({ host: "core.internal", [CAPABILITY_HEADER]: tokenB }), [2]);
  });

  it("lets the web UI's signed cross-tenant delivery poll through the core's unmapped service host", async () => {
    const poll = apiRoutes.find((route) => "path" in route && route.path === "/v1/deliveries/across-tenants");
    assert.ok(poll);
    assert.equal(await seen({ host: "core.internal:8080" }, poll), "unbound");
    assert.equal(await seen({ host: "core.internal:8080" }), 421);
  });

  it("refuses a deleted tenant's host, even with a live tenant's credential, until the host is mapped again", async () => {
    const gone = randomUUID();
    await owner.query("INSERT INTO tenants(id) VALUES ($1)", [gone]);
    assert.equal(await tenancy.mapHost(gone, "gone.example.test"), "mapped");
    await owner.query("DELETE FROM tenants WHERE id = $1", [gone]);
    const fresh = createTenancy(appPool, ownerPool);
    assert.deepEqual(await fresh.hostTenant("gone.example.test"), { multi: true, retired: true });
    const tokenA = await withTenant(a, () => mintCapabilityToken(claims, SECRET));
    const req = new IncomingMessage(new Socket());
    req.headers = { host: "gone.example.test", [CAPABILITY_HEADER]: tokenA };
    const res = new ServerResponse(req);
    let reached = false;
    await withRequestTenant(req, res, { auth: "source" }, SECRET, fresh, () => {
      reached = true;
    });
    assert.equal(reached, false);
    assert.equal(res.statusCode, 421);
    assert.equal(await fresh.mapHost(a, "gone.example.test"), "mapped");
    assert.deepEqual(await fresh.hostTenant("gone.example.test"), { tenant: a, multi: true });
    assert.equal(await fresh.unmapHost(a, "gone.example.test"), true);
  });
});

describe("tenant settings", { skip }, () => {
  it("validates, stores and isolates each tenant's settings", async () => {
    assert.deepEqual(await tenancy.updateSettings(a, { slackBridgeToken: "bridge-a", modelGatewayKey: "key-a" }), {
      ok: true,
      keys: ["modelGatewayKey", "slackBridgeToken"],
    });
    assert.equal((await tenancy.updateSettings(b, { slackBridgeToken: "" })).ok, false);
    assert.equal((await tenancy.updateSettings(b, { unknownSetting: "x" })).ok, false);
    assert.deepEqual(await tenancy.updateSettings(b, { env: { S3_PREFIX: "tenants/b/" } }), {
      ok: true,
      keys: ["env"],
    });
    assert.equal(await withTenant(a, () => tenantSetting("slackBridgeToken")), "bridge-a");
    assert.equal(await withTenant(b, () => tenantSetting("slackBridgeToken")), undefined);
    assert.deepEqual(await withTenant(b, () => tenantSetting("env")), { S3_PREFIX: "tenants/b/" });
    assert.equal(await tenantSetting("slackBridgeToken"), undefined);
    assert.deepEqual(await tenancy.updateSettings(a, { modelGatewayKey: null }), {
      ok: true,
      keys: ["slackBridgeToken"],
    });
    assert.equal(await withTenant(a, () => tenantSetting("modelGatewayKey")), undefined);
  });

  it("keeps a tenant's known settings when its row has keys this core does not know, and leaves those keys in place on write", async () => {
    const c = randomUUID();
    const stored = { modelGatewayKey: "key-c", futureSetting: "x", env: { S3_PREFIX: "c/", FUTURE_ENV: "y" } };
    await owner.query("INSERT INTO tenants(id, settings) VALUES ($1, $2)", [c, JSON.stringify(stored)]);
    const fresh = createTenancy(appPool, ownerPool);
    assert.deepEqual(await fresh.settings(c), { modelGatewayKey: "key-c", env: { S3_PREFIX: "c/" } });
    await fresh.refreshSettings();
    assert.equal(
      withTenant(c, () => loadedTenantSettings().modelGatewayKey),
      "key-c",
    );
    assert.deepEqual(await fresh.updateSettings(c, { slackBridgeToken: "bridge-c" }), {
      ok: true,
      keys: ["env", "modelGatewayKey", "slackBridgeToken"],
    });
    const row = await owner.query("SELECT settings FROM tenants WHERE id = $1", [c]);
    assert.deepEqual(row.rows[0]?.settings, { ...stored, slackBridgeToken: "bridge-c" });
    await owner.query("DELETE FROM tenants WHERE id = $1", [c]);
  });

  it("loads the bound tenant's settings when a request binds it", async () => {
    let key: string | undefined;
    await tenancy.updateSettings(b, { modelGatewayKey: "key-b" });
    const req = new IncomingMessage(new Socket());
    req.headers = { host: "b.example.test" };
    await withRequestTenant(req, new ServerResponse(req), { auth: "public" }, SECRET, tenancy, () => {
      key = loadedTenantSettings().modelGatewayKey;
    });
    assert.equal(key, "key-b");
    assert.equal(
      withTenant(a, () => loadedTenantSettings().modelGatewayKey),
      undefined,
    );
  });

  it("lets the non-owner login read only the bound tenant's settings, and no host rows directly", async () => {
    const own = await withTenant(a, () => appPool.q("SELECT qm_tenant_settings() AS s"));
    assert.deepEqual(own[0]?.s, { slackBridgeToken: "bridge-a" });
    await assert.rejects(appPool.q("SELECT qm_tenant_settings()"), { code: "42501" });
    await assert.rejects(appPool.q("SELECT host FROM tenant_hosts"), { code: "42501" });
    await assert.rejects(appPool.q("SELECT settings FROM tenants"), { code: "42501" });
  });
});
