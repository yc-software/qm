import "../support/auto-fake-sprites.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { deriveTenantSecret } from "../../plugins/chassis/src/tenant-settings.ts";
import { createServer } from "../../src/api/server.ts";
import { mintPortalIdentity } from "../../src/auth/portal-identity.ts";
import { signRequest } from "../../src/auth/source-auth.ts";
import { createPgPool, migrateRegisteredPgSchemas, type PgPool } from "../../src/persistence/pg-pool.ts";
import { tenant } from "../../src/tenant.ts";
import { createTenantDirectory, useTenantDirectory, type TenantDirectory } from "../../src/tenants/directory.ts";
import { createTenantFront } from "../../src/tenants/host.ts";
import { upsertTenant, type TenantRecord } from "../../src/tenants/registry.ts";
import { serverDeps, type BuiltApp } from "../../src/wiring.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";

const URL_ADMIN = process.env.DATABASE_URL;
const skip = URL_ADMIN ? false : "set DATABASE_URL (a Postgres) to run the one-app tenant test";
const DB = `qm_one_app_${process.pid}`;
const ROLE = "qm_one_app";
const SIGNING = "one-app-core-signing-secret-0123456789";
const CAPABILITY = "one-app-capability-secret-0123456789";
const PORTAL = "one-app-portal-identity-secret-012345";
const ACME = "6c1d8f55-2a2b-4c3d-8e9f-00000000a001";
const BETA = "6c1d8f55-2a2b-4c3d-8e9f-00000000b002";
const GAMMA = "6c1d8f55-2a2b-4c3d-8e9f-00000000c003";

let admin: pg.Client;
let registry: PgPool;
let directory: TenantDirectory;
let built: BuiltApp;
let front: Server;
let base = "";

function row(id: string, slug: string): TenantRecord {
  return { id, slug, orgId: slug, hosts: [`${slug}.example.test`], status: "active", oidcAdmin: false, secrets: {} };
}

async function call(
  host: string,
  tenantId: string | undefined,
  method: string,
  target: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = (shared: string) => (tenantId ? deriveTenantSecret(shared, tenantId) : shared);
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(base + target, {
    method,
    headers: {
      "x-forwarded-host": host,
      "content-type": "application/json",
      "x-timestamp": String(ts),
      "x-signature": signRequest(secret(SIGNING), ts, `${method}\n${target}\n${body}`),
      "x-portal-identity": await mintPortalIdentity(
        { p: "alice@example.test", exp: Date.now() + 60_000 },
        secret(PORTAL),
      ),
    },
    ...(body ? { body } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

before(async () => {
  if (!URL_ADMIN) return;
  admin = new pg.Client({ connectionString: URL_ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  const password = randomBytes(12).toString("hex");
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE}`);
  const url = new URL(URL_ADMIN);
  url.username = ROLE;
  url.password = password;
  url.pathname = `/${DB}`;
  const databaseUrl = url.toString();
  const config = testConfig({
    databaseUrl,
    multitenant: true,
    dataDir: mkdtempSync(join(tmpdir(), "one-app-")),
    signingSecret: SIGNING,
    capabilitySecret: CAPABILITY,
    portalIdentitySecret: PORTAL,
    requireSignedPortalIdentity: true,
    publicUrl: "https://home.example.test",
    apiBaseUrl: "https://home.example.test",
  });
  built = buildApp(config);
  await migrateRegisteredPgSchemas(databaseUrl);
  registry = createPgPool(databaseUrl);
  for (const [id, slug] of [
    [ACME, "acme"],
    [BETA, "beta"],
  ] as const)
    await upsertTenant(registry, row(id, slug), undefined);
  directory = createTenantDirectory({
    databaseUrl,
    pool: registry,
    secretsKey: undefined,
    home: tenant(),
    homeHosts: ["home.example.test"],
    homeSandboxPrefix: "qm",
    prepare: () => built.start(),
  });
  useTenantDirectory(directory);
  front = createTenantFront(createServer(built.app, serverDeps(config, built)));
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
});

after(async () => {
  if (!URL_ADMIN) return;
  front?.close();
  useTenantDirectory(undefined);
  await directory?.close();
  await registry?.close();
  await built?.runtime.stop();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

test("one app: a request on a tenant's host reads and writes only that tenant's rows", { skip }, async () => {
  const key = `k${randomUUID().slice(0, 8)}`;
  const put = await call("acme.example.test", ACME, "PUT", "/v1/ui-state", {
    principalId: "alice@example.test",
    key,
    value: { owner: "acme" },
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const read = (host: string, id: string | undefined) =>
    call(host, id, "GET", `/v1/ui-state?principalId=alice%40example.test&key=${key}`);
  assert.deepEqual((await read("acme.example.test", ACME)).body.value, { owner: "acme" });
  assert.equal((await read("beta.example.test", BETA)).body.value, null);
  assert.equal((await read("home.example.test", undefined)).body.value, null);
});

test("one app: a request signed with one tenant's secrets is refused on another tenant's host", { skip }, async () => {
  const target = `/v1/ui-state?principalId=alice%40example.test&key=probe`;
  assert.equal((await call("acme.example.test", ACME, "GET", target)).status, 200);
  assert.equal((await call("beta.example.test", ACME, "GET", target)).status, 401);
  assert.equal((await call("home.example.test", ACME, "GET", target)).status, 401);
});

test("one app: a new tenant row is served on its next request without a restart", { skip }, async () => {
  const target = `/v1/ui-state?principalId=alice%40example.test&key=probe`;
  assert.equal((await call("gamma.example.test", GAMMA, "GET", target)).status, 404);
  await upsertTenant(registry, row(GAMMA, "gamma"), undefined);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal((await call("gamma.example.test", GAMMA, "GET", target)).status, 200);
});
