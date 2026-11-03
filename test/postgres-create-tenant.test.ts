import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createTenant } from "../src/tenants/create.ts";
import { devTenantId } from "../scripts/dev/lib/envctx.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { prepareDevTenant } from "../scripts/dev/supervisor/durability.ts";

const URL = process.env.DATABASE_OWNER_URL;
const skip = URL ? false : "set DATABASE_OWNER_URL (a Postgres owner login) to run the tenant creation test";

test("creating a tenant inserts exactly the given id once, even when creations race", { skip }, async () => {
  const schema = `tenant_${randomUUID().replaceAll("-", "")}`;
  const url = new globalThis.URL(URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new pg.Pool({ connectionString: url.toString() });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(
    `CREATE TABLE ${schema}.tenants(id UUID PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  try {
    const other = randomUUID();
    await admin.query(`INSERT INTO ${schema}.tenants(id) VALUES ($1)`, [other]);
    const tenant = randomUUID();
    const raced = await Promise.all(Array.from({ length: 6 }, () => createTenant(url.toString(), tenant)));
    assert.ok(raced.every((result) => result.tenant === tenant));
    assert.equal(raced.filter((result) => result.created).length, 1);
    const { rows } = await admin.query(`SELECT id::text AS id FROM ${schema}.tenants ORDER BY id`);
    assert.deepEqual(
      rows.map((row) => row.id),
      [other, tenant].sort(),
    );
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("a dev instance creates the tenant its database derives and names it on every later call, or stops", async () => {
  const databaseUrl = "postgres://dev@127.0.0.1:5432/qm_dev";
  const tenant = devTenantId(databaseUrl);
  assert.equal(devTenantId(databaseUrl), tenant);
  assert.notEqual(devTenantId(`${databaseUrl}2`), tenant);
  assert.match(tenant, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  const requests: { path?: string; tenant?: string; authorization?: string; body: string }[] = [];
  let status = 200;
  const core = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const header = req.headers["x-qm-tenant"];
      requests.push({
        path: req.url?.split("?")[0],
        ...(typeof header === "string" ? { tenant: header } : {}),
        authorization: req.headers.authorization,
        body,
      });
      res.writeHead(status).end("{}");
    });
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  const inputs = {
    databaseUrl,
    adminGrantsSeed: "dev@example.com:org_admin",
    baseEnv: {
      CORE_SIGNING_SECRET: "s".repeat(64),
      DEPLOYMENT_CONTROL_SECRET: "c".repeat(64),
      ANTHROPIC_API_KEY: "sk-dev",
      PI_MODEL: "",
      LOOPS_USERS: "dev@example.com",
      PORT: "8080",
    },
    ports: { core: (core.address() as AddressInfo).port },
  };
  const phases: string[] = [];
  const record = (name: string, state: string, detail?: string) => phases.push(`${name} ${state} ${detail ?? ""}`);
  try {
    await prepareDevTenant(inputs, record);
    status = 404;
    await assert.rejects(
      prepareDevTenant(inputs, record),
      /tenant settings: \/v1\/tenants\/[0-9a-f-]{36} failed \(404\)/,
    );
  } finally {
    await new Promise<void>((resolve) => core.close(() => resolve()));
  }
  assert.deepEqual(phases, [
    "tenant start ",
    `tenant ok wrote ADMIN_GRANTS, inbox_loops for personal:dev@example.com, anthropic API key to the dev tenant ${tenant}`,
    "tenant start ",
  ]);
  assert.deepEqual(
    requests.slice(0, 4).map((request) => [request.path, request.tenant]),
    [
      [`/v1/tenants/${tenant}`, undefined],
      ["/v1/tenant-settings", tenant],
      ["/v1/admin/scopes/tenant/feature-flags", tenant],
      ["/v1/admin/model-providers/anthropic", tenant],
    ],
  );
  assert.ok(requests.every((request) => request.authorization === `Bearer ${"c".repeat(64)}`));
  assert.deepEqual(JSON.parse(requests[1]!.body), { env: { ADMIN_GRANTS: "dev@example.com:org_admin" } });
  assert.deepEqual(JSON.parse(requests[3]!.body), { apiKey: "sk-dev", ifUnset: true });
});
