import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { test, after, before } from "node:test";
import pg from "pg";
import {
  createHostFront,
  normalizeHost,
  proxyTarget,
  requestHost,
  routeForHost,
  type HostRoute,
  type HostTarget,
} from "../../plugins/chassis/src/tenant-hosts.ts";
import { relocateEmbeddedAuth, tenantServiceEnv } from "../../plugins/chassis/src/tenant-workers.ts";
import { configurePgTenancy, createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { loadConfig } from "../../src/config.ts";
import { registerTenantSettings, tenant, tenantFor, tenantSettings, withTenant } from "../../src/tenant.ts";
import { tenantConfig } from "../../src/tenants/tenant-config.ts";
import {
  activeTenants,
  createTenantDirectory,
  useTenantDirectory,
  type TenantDirectory,
} from "../../src/tenants/directory.ts";
import { createTenantFront } from "../../src/tenants/host.ts";
import { type TenantRecord, upsertTenant } from "../../src/tenants/registry.ts";

const ACME_ID = "0f8e2c4a-1b2c-4d3e-8f90-123456789abc";

const record: TenantRecord = {
  id: ACME_ID,
  slug: "acme",
  orgId: "acme",
  hosts: ["acme.example.test"],
  status: "active",
  sandboxNamePrefix: "qm-acme-sbx",
  oidcClientId: "acme",
  oidcLabel: "Example SSO",
  oidcAdmin: true,
  secrets: { oidcClientSecret: "acme-trusted-client-secret", modelGatewayApiKey: "acme-gateway-key" },
};

const deployment = {
  DATABASE_URL: "postgres://db/qm",
  ORG_ID: "home",
  CORE_ORG_ID: "home",
  PORT: "8080",
  PUBLIC_API_URL: "https://home.example.test",
  PORTAL_PUBLIC_URL: "https://home.example.test",
  AUTH_ISSUER: "https://home.example.test/idp",
  TRUSTED_OIDC_ADMIN_ISSUER: "https://auth.example.test",
  CORE_SIGNING_SECRET: "home-core-secret",
  PORTAL_SESSION_SECRET: "home-portal-secret",
  AUTH_CLIENT_SECRET: "home-client-secret",
  OIDC_CLIENT_SECRET: "home-client-secret",
  CONNECTOR_SECRET_KEY: "home-connector-key",
  MODEL_GATEWAY_API_KEY: "home-gateway-key",
  QM_SLACK_SERVICE_URL: "https://slack.example.test",
  QM_SLACK_SERVICE_TOKEN: "home-slack-token",
  ADMIN_GRANTS: "owner@home.example:org_admin",
  PORTAL_APPS_DOMAIN: "apps.home.example.test",
  PORTAL_TRUSTED_OIDC: JSON.stringify({ issuer: "https://auth.example.test", clientId: "home" }),
  PORTAL_TRUSTED_OIDC_CLIENT_SECRET: "home-trusted-client-secret",
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function named(name: string): HostTarget {
  return {
    request: (_req, res) => void res.end(name),
    upgrade: (_req, socket) => void socket.end(),
  };
}

test("request host prefers the forwarded host and drops the port", () => {
  assert.equal(
    requestHost({ host: "core.internal:8080", "x-forwarded-host": "Acme.Example.test:443" }),
    "acme.example.test",
  );
  assert.equal(requestHost({ host: "acme.example.test:8080" }), "acme.example.test");
  assert.equal(requestHost({ "x-forwarded-host": "a.test, b.test", host: "c.test" }), "a.test");
  assert.equal(requestHost({}), undefined);
  assert.equal(normalizeHost("[::1]:8080"), "[::1]");
});

test("routes match exact hosts before published-app domains", () => {
  const routes: HostRoute<string>[] = [
    { hosts: ["acme.example.test"], appsDomain: "apps.acme.example.test", target: "acme" },
    { hosts: ["beta.example.test"], appsDomain: "apps.beta.example.test", target: "beta" },
  ];
  assert.equal(routeForHost(routes, "acme.example.test"), "acme");
  assert.equal(routeForHost(routes, "dash.apps.beta.example.test"), "beta");
  assert.equal(routeForHost(routes, "apps.acme.example.test"), "acme");
  assert.equal(routeForHost(routes, "evilapps.acme.example.test"), undefined);
  assert.equal(routeForHost(routes, "other.example.test"), undefined);
  assert.equal(routeForHost(routes, undefined), undefined);
});

test("the front dispatches by host and sends unknown hosts to home only for health checks", async (t) => {
  const front = createHostFront(
    () => [
      { hosts: ["acme.example.test"], target: named("acme") },
      { hosts: ["home.example.test"], target: named("home") },
    ],
    () => named("home"),
  );
  const port = await listen(front);
  t.after(() => front.close());
  assert.deepEqual(await get(port, "/v1/x", { host: "acme.example.test" }), { status: 200, body: "acme" });
  assert.deepEqual(await get(port, "/v1/x", { host: "internal", "x-forwarded-host": "home.example.test" }), {
    status: 200,
    body: "home",
  });
  assert.deepEqual(await get(port, "/healthz", { host: "10.0.0.7:8080" }), { status: 200, body: "home" });
  assert.equal((await get(port, "/v1/x", { host: "stranger.test" })).status, 404);
});

test("the proxy target keeps the original host for the tenant worker", async (t) => {
  const upstream = createServer((req, res) => res.end(String(req.headers.host)));
  const upstreamPort = await listen(upstream);
  const front = createHostFront(
    () => [{ hosts: ["acme.example.test"], target: proxyTarget(upstreamPort) }],
    () => undefined,
  );
  const port = await listen(front);
  t.after(() => {
    front.close();
    upstream.close();
  });
  assert.deepEqual(await get(port, "/", { host: "acme.example.test" }), { status: 200, body: "acme.example.test" });
});

test("core verifies each tenant with the derived secrets its surfaces sign with, distinct per tenant", () => {
  const config = loadConfig({
    ...deployment,
    CAPABILITY_SECRET: "home-capability-secret",
    PORTAL_IDENTITY_SECRET: "home-portal-identity-secret",
    MODEL_GATEWAY_URL: "https://gateway.example.test",
    MODEL_GATEWAY_API_KEY_HEADER: "authorization",
  });
  const other = { ...record, id: "0f8e2c4a-1b2c-4d3e-8f90-000000000002", slug: "other", orgId: "other" };
  registerTenantSettings([record, other]);
  const coreFor = (t: TenantRecord) => withTenant(tenantFor(t.orgId, t.id, t.slug), () => tenantConfig(config));
  const portal = tenantServiceEnv(deployment, record);
  assert.equal(coreFor(record).signingSecret, portal.CORE_SIGNING_SECRET);
  assert.notEqual(coreFor(record).signingSecret, deployment.CORE_SIGNING_SECRET);
  assert.notEqual(coreFor(other).signingSecret, coreFor(record).signingSecret);
  assert.equal(portal.AUTH_CLIENT_SECRET, portal.OIDC_CLIENT_SECRET);
  assert.equal(tenantConfig(config).signingSecret, deployment.CORE_SIGNING_SECRET);
  assert.equal(coreFor(record).publicUrl, "https://acme.example.test");
  assert.equal(coreFor(record).sandboxNamePrefix, "qm-acme-sbx");
  assert.equal(coreFor(record).s3Prefix, "tenants/acme/");
  assert.equal(coreFor(record).modelGatewayApiKey, "acme-gateway-key");
  assert.equal(coreFor(record).adminGrants, undefined);
  assert.equal(tenantConfig(config).adminGrants, deployment.ADMIN_GRANTS);
  registerTenantSettings([]);
});

test("surface env names the tenant to core and points trusted sign-in at the tenant's client", () => {
  const env = tenantServiceEnv(deployment, record);
  assert.equal(env.CORE_ORG_ID, "acme");
  assert.equal(env.CORE_TENANT_HOST, "acme.example.test");
  assert.equal(env.PORTAL_PUBLIC_URL, "https://acme.example.test");
  assert.deepEqual(JSON.parse(env.PORTAL_TRUSTED_OIDC!), { issuer: "https://auth.example.test", clientId: "acme" });
  assert.equal(env.PORTAL_TRUSTED_OIDC_CLIENT_SECRET, "acme-trusted-client-secret");
  assert.equal(env.PORTAL_TRUSTED_OIDC_LABEL, "Example SSO");
  assert.equal(env.PORTAL_TRUSTED_OIDC_ADMIN, "1");
  const plain = tenantServiceEnv(deployment, { ...record, oidcClientId: undefined, secrets: {} });
  assert.equal(plain.PORTAL_TRUSTED_OIDC, undefined);
  assert.equal(plain.PORTAL_TRUSTED_OIDC_CLIENT_SECRET, undefined);
  assert.equal(plain.MODEL_GATEWAY_API_KEY, "home-gateway-key");
});

test("the home tenant's surface env is the deployment env", () => {
  const home = tenantServiceEnv(deployment, {
    slug: "home",
    orgId: "home",
    hosts: ["home.example.test"],
    status: "active",
    oidcAdmin: false,
    secrets: {},
  });
  assert.deepEqual(home, { ...deployment, CORE_TENANT_HOST: "home.example.test" });
});

test("embedded auth moves to its own loopback port, rewriting endpoints that pointed at it", async () => {
  const env = await relocateEmbeddedAuth({
    AUTH_EMBEDDED: "1",
    AUTH_BROKER_UPSTREAM: "http://127.0.0.1:8099",
    OIDC_TOKEN_ENDPOINT: "http://127.0.0.1:8099/idp/token",
    OIDC_ISSUER: "https://acme.example.test/idp",
  });
  const moved = new URL(env.AUTH_BROKER_UPSTREAM!);
  assert.equal(moved.hostname, "127.0.0.1");
  assert.notEqual(moved.port, "8099");
  assert.equal(env.OIDC_TOKEN_ENDPOINT, `${env.AUTH_BROKER_UPSTREAM}/idp/token`);
  assert.equal(env.OIDC_ISSUER, "https://acme.example.test/idp");
  const plain = { AUTH_BROKER_UPSTREAM: "http://127.0.0.1:8099" };
  assert.equal(await relocateEmbeddedAuth(plain), plain);
});

const URL_ADMIN = process.env.DATABASE_URL!;
const DB = `qm_mt_host_${process.pid}`;
const ROLE = "qm_mt_host_app";
const ACME = "5b0c7e44-1f1a-4c6e-9d2a-00000000a001";
const BETA = "5b0c7e44-1f1a-4c6e-9d2a-00000000b002";
const GAMMA = "5b0c7e44-1f1a-4c6e-9d2a-00000000c003";
const DELTA = "5b0c7e44-1f1a-4c6e-9d2a-00000000d004";

let admin: pg.Client;
let registry: PgPool;
let front: Server;
let frontPort = 0;
let appUrl = "";
let clock = 0;
let directory: TenantDirectory;

function frontGet(path: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return get(frontPort, path, { host: hostHeader });
}

async function eventually<T>(read: () => Promise<T>, expected: T): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!isDeepStrictEqual(await read(), expected) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await read(), expected);
}

async function seen(path: string, hostHeader: string): Promise<unknown> {
  const res = await frontGet(path, hostHeader);
  return res.status === 200 ? JSON.parse(res.body) : res.status;
}

function tenantRow(id: string, slug: string, status: TenantRecord["status"] = "active"): TenantRecord {
  return { id, slug, orgId: slug, hosts: [`${slug}.example.test`], status, oidcAdmin: false, secrets: {} };
}

before(async () => {
  admin = new pg.Client({ connectionString: URL_ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
  );
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  const url = new URL(URL_ADMIN);
  url.username = ROLE;
  url.password = ROLE;
  url.pathname = `/${DB}`;
  appUrl = url.toString();
  configurePgTenancy(true);
  registry = createPgPool(appUrl);
  await registry.pool();
  for (const [id, slug] of [
    [ACME, "acme"],
    [BETA, "beta"],
  ] as const)
    await upsertTenant(registry, tenantRow(id, slug), undefined);
  directory = createTenantDirectory({
    databaseUrl: appUrl,
    pool: registry,
    secretsKey: undefined,
    home: tenant(),
    homeHosts: ["home.example.test"],
    homeSandboxPrefix: "qm",
    now: () => clock,
  });
  useTenantDirectory(directory);
  const app = createServer((req, res) =>
    res.end(
      req.url === "/prefix"
        ? (tenantSettings().sandboxNamePrefix ?? "none")
        : JSON.stringify({ id: tenant().id ?? null, org: tenant().orgId }),
    ),
  );
  front = createTenantFront(app);
  frontPort = await listen(front);
});

after(async () => {
  front?.close();
  useTenantDirectory(undefined);
  await directory?.close();
  await registry?.close();
  configurePgTenancy(false);
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

test("one app serves the home tenant and every registry tenant by host", async () => {
  assert.deepEqual(await seen("/v1/x", "acme.example.test"), { id: ACME, org: "acme" });
  assert.deepEqual(await seen("/v1/x", "beta.example.test:443"), { id: BETA, org: "beta" });
  assert.deepEqual(await seen("/v1/x", "home.example.test"), { id: null, org: tenant().orgId });
  assert.deepEqual(await seen("/healthz", "10.1.2.3"), { id: null, org: tenant().orgId });
  assert.equal(await seen("/v1/x", "stranger.example.test"), 404);
  assert.deepEqual(
    (await activeTenants()).map((t) => t.id ?? null),
    [null, ACME, BETA],
  );
});

test("a new registry row is served on its next request and a suspended one stops being served", async () => {
  await upsertTenant(registry, tenantRow(GAMMA, "gamma"), undefined);
  clock += 1_000;
  assert.deepEqual(await seen("/v1/x", "gamma.example.test"), { id: GAMMA, org: "gamma" });
  await upsertTenant(registry, tenantRow(BETA, "beta", "suspended"), undefined);
  await eventually(() => seen("/v1/x", "beta.example.test"), 404);
  assert.deepEqual(
    (await activeTenants()).map((t) => t.id ?? null),
    [null, ACME, GAMMA],
  );
});

test("a tenant's changed settings are live on its next request without a restart", async () => {
  const prefix = async () => (await frontGet("/prefix", "acme.example.test")).body;
  assert.equal(await prefix(), "none");
  await upsertTenant(registry, { ...tenantRow(ACME, "acme"), sandboxNamePrefix: "a2" }, undefined);
  await eventually(prefix, "a2");
});

test("a tenant reusing another tenant's org id is not served", async () => {
  await upsertTenant(registry, { ...tenantRow(DELTA, "delta"), orgId: "acme" }, undefined);
  clock += 1_000;
  assert.equal(await seen("/v1/x", "delta.example.test"), 404);
  assert.deepEqual(await seen("/v1/x", "acme.example.test"), { id: ACME, org: "acme" });
});

test("a tenant whose preparation fails is unavailable while every other tenant is served, and is retried later", async () => {
  let attempts = 0;
  const failing = createTenantDirectory({
    databaseUrl: appUrl,
    pool: registry,
    secretsKey: undefined,
    home: tenant(),
    homeHosts: ["home.example.test"],
    homeSandboxPrefix: "qm",
    now: () => clock,
    prepare: async () => {
      if (tenant().id === ACME && attempts++ === 0) throw new Error("hydrate failed");
    },
  });
  try {
    await assert.rejects(failing.byHost("acme.example.test"), /hydrate failed/);
    assert.equal((await failing.byHost("gamma.example.test"))?.id, GAMMA);
    assert.deepEqual(
      (await failing.active()).map((t) => t.id ?? null),
      [null, GAMMA],
    );
    await assert.rejects(failing.byHost("acme.example.test"), /hydrate failed/);
    clock += 30_000;
    assert.equal((await failing.byHost("acme.example.test"))?.id, ACME);
    assert.equal(attempts, 2);
  } finally {
    await failing.close();
  }
});
