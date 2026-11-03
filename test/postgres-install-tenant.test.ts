import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { AmbiguousInstallTenant, ensureInstallTenant } from "../src/tenants/install.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { prepareDevTenant } from "../scripts/dev/supervisor/durability.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the install tenant test";

test(
  "a fresh install creates exactly one tenant even when installs race, and refuses a database with several",
  { skip },
  async () => {
    const schema = `install_${randomUUID().replaceAll("-", "")}`;
    const url = new globalThis.URL(URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(
      `CREATE TABLE ${schema}.tenants(id UUID PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    try {
      const raced = await Promise.all(Array.from({ length: 6 }, () => ensureInstallTenant(url.toString())));
      assert.equal(new Set(raced.map((result) => result.tenant)).size, 1);
      assert.equal(raced.filter((result) => result.created).length, 1);
      assert.deepEqual(await ensureInstallTenant(url.toString()), { tenant: raced[0]!.tenant, created: false });
      const other = randomUUID();
      await admin.query(`INSERT INTO ${schema}.tenants(id) VALUES ($1)`, [other]);
      await assert.rejects(ensureInstallTenant(url.toString()), (error: unknown) => {
        assert.ok(error instanceof AmbiguousInstallTenant);
        assert.deepEqual(error.tenants, [raced[0]!.tenant, other].sort());
        return true;
      });
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test("a dev instance installs its tenant through core and names it on every later call, or stops", async () => {
  const tenant = randomUUID();
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
      res.writeHead(status).end(req.url?.startsWith("/v1/install/tenant") ? JSON.stringify({ tenant }) : "{}");
    });
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  const inputs = {
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
    await assert.rejects(prepareDevTenant(inputs, record), /tenant settings: \/v1\/install\/tenant failed \(404\)/);
  } finally {
    await new Promise<void>((resolve) => core.close(() => resolve()));
  }
  assert.deepEqual(phases, [
    "tenant start ",
    `tenant ok wrote ADMIN_GRANTS, inbox_loops for personal:dev@example.com, anthropic API key to the install tenant ${tenant}`,
    "tenant start ",
  ]);
  assert.deepEqual(
    requests.slice(0, 4).map((request) => [request.path, request.tenant]),
    [
      ["/v1/install/tenant", undefined],
      ["/v1/tenant-settings", tenant],
      ["/v1/admin/scopes/tenant/feature-flags", tenant],
      ["/v1/admin/model-providers/anthropic", tenant],
    ],
  );
  assert.ok(requests.every((request) => request.authorization === `Bearer ${"c".repeat(64)}`));
  assert.deepEqual(JSON.parse(requests[1]!.body), { env: { ADMIN_GRANTS: "dev@example.com:org_admin" } });
  assert.deepEqual(JSON.parse(requests[3]!.body), { apiKey: "sk-dev", ifUnset: true });
});
