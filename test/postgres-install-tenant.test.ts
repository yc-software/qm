import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ensureInstallTenant, InstallTenantConflict } from "../src/tenants/install.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { prepareDevTenant } from "../scripts/dev/supervisor/durability.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the install tenant test";

test("an install gets exactly one tenant row, even when provisioning races", { skip }, async () => {
  const schema = `install_${randomUUID().replaceAll("-", "")}`;
  const url = new globalThis.URL(URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new pg.Pool({ connectionString: url.toString() });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE TABLE ${schema}.tenants(
    id UUID PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureInstallTenant(url.toString())));
    assert.equal(new Set(results.map((result) => result.tenant)).size, 1);
    assert.equal(results.filter((result) => result.created).length, 1);
    const again = await ensureInstallTenant(url.toString());
    assert.deepEqual(again, { tenant: results[0]!.tenant, created: false });
    await admin.query(`INSERT INTO ${schema}.tenants(id, slug, name) VALUES ($1, 'second', 'Second')`, [randomUUID()]);
    await assert.rejects(ensureInstallTenant(url.toString()), InstallTenantConflict);
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test(
  "an existing install keeps its carried-over tenant id and a dev instance writes its settings to it",
  { skip },
  async () => {
    const schema = `install_${randomUUID().replaceAll("-", "")}`;
    const url = new globalThis.URL(URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(
      `CREATE TABLE ${schema}.tenants(id UUID PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL)`,
    );
    const carried = randomUUID();
    await admin.query(`INSERT INTO ${schema}.tenants(id, slug, name) VALUES ($1, 'acme', 'Acme')`, [carried]);
    try {
      assert.deepEqual(await ensureInstallTenant(url.toString()), { tenant: carried, created: false });
      const requests: { path?: string; authorization?: string; body: string }[] = [];
      let status = 200;
      const core = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          requests.push({ path: req.url, authorization: req.headers.authorization, body });
          res.writeHead(status).end("{}");
        });
      });
      await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
      const inputs = {
        databaseUrl: url.toString(),
        adminGrantsSeed: "dev@example.com:org_admin",
        baseEnv: {
          CORE_SIGNING_SECRET: "s".repeat(64),
          DEPLOYMENT_CONTROL_SECRET: "c".repeat(64),
          ANTHROPIC_API_KEY: "sk-dev",
          PI_MODEL: "",
          PORT: "8080",
        },
        ports: { core: (core.address() as AddressInfo).port },
      };
      const phases: string[] = [];
      const record = (name: string, state: string, detail?: string) => phases.push(`${name} ${state} ${detail ?? ""}`);
      try {
        await prepareDevTenant(inputs, record);
        status = 404;
        await prepareDevTenant(inputs, record);
      } finally {
        await new Promise<void>((resolve) => core.close(() => resolve()));
      }
      assert.deepEqual(phases, [
        "tenant start ",
        `tenant ok using install tenant ${carried}`,
        "tenant ok wrote ADMIN_GRANTS, ANTHROPIC_API_KEY to the install tenant",
        "tenant start ",
        `tenant ok using install tenant ${carried}`,
        "tenant warn this core has no tenant settings route yet",
      ]);
      assert.equal(requests[0]!.path, "/v1/tenant-settings");
      assert.equal(requests[0]!.authorization, `Bearer ${"c".repeat(64)}`);
      assert.deepEqual(JSON.parse(requests[0]!.body), {
        env: { ANTHROPIC_API_KEY: "sk-dev", ADMIN_GRANTS: "dev@example.com:org_admin" },
      });
      const { rows } = await admin.query(`SELECT id::text AS id, slug FROM ${schema}.tenants`);
      assert.deepEqual(rows, [{ id: carried, slug: "acme" }]);
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
