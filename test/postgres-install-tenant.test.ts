import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ensureInstallTenant, InstallTenantConflict } from "../src/tenants/install.ts";
import { ensureDevInstallTenant } from "../scripts/dev/supervisor/durability.ts";

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

test("an existing install keeps its carried-over tenant id", { skip }, async () => {
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
    const phases: string[] = [];
    await ensureDevInstallTenant(url.toString(), (name, state, detail) =>
      phases.push(`${name} ${state} ${detail ?? ""}`),
    );
    assert.deepEqual(phases, ["tenant start ", `tenant ok using install tenant ${carried}`]);
    const { rows } = await admin.query(`SELECT id::text AS id, slug FROM ${schema}.tenants`);
    assert.deepEqual(rows, [{ id: carried, slug: "acme" }]);
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
