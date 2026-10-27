import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importTenant, migrateWithBuild } from "../../src/tenants/import.ts";
import { upsertTenant } from "../../src/tenants/registry.ts";
import { withClient } from "../support/pg-client.ts";

const databaseUrl = process.env.DATABASE_URL;

function databaseNamed(suffix: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `${url.pathname}_${suffix}`;
  return url.toString();
}

async function createDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  await withClient(databaseUrl!, (client) => client.query(`CREATE DATABASE "${name}"`));
}

async function seedSource(url: string, label: string, audits: number): Promise<void> {
  await withClient(url, async (client) => {
    await client.query(
      `INSERT INTO directory_channels(org_id, channel_id, name, name_lc) VALUES ('acme', 'C1', $1, lower($1)), ('acme', 'C2', $1, lower($1))`,
      [label],
    );
    await client.query(
      `INSERT INTO audit_log(at, principal_id, action, resource, scope_label)
       SELECT g, $1, 'seed', 'r', 's' FROM generate_series(1, $2::int) g`,
      [label, audits],
    );
    await client.query(
      `INSERT INTO acl_grants(owner_scope_id, path, grantee_scope_id, permission, granted_by)
       VALUES ('org:acme', '/', 'user:a', 'read', 'user:admin')`,
    );
    await client.query("CREATE SCHEMA cleanup_backup");
    await client.query("CREATE TABLE cleanup_backup.directory_channels AS TABLE public.directory_channels");
  });
}

test(
  "imports two company databases with overlapping keys into one target as isolated tenants",
  { skip: !databaseUrl, timeout: 600_000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qm-tenant-import-"));
    const baseEnv = {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      SANDBOX_BACKEND: "local",
      CONNECTOR_SECRET_KEY: "tenant-import-test-connector-secret",
      CAPABILITY_SECRET: "tenant-import-test-capability-secret",
      DATA_DIR: dataDir,
    };
    const migrateLegacy = migrateWithBuild(baseEnv, { tenantize: false });
    const migrate = migrateWithBuild(baseEnv, { tenantize: true });
    const appRole = `qm_import_app_${randomBytes(4).toString("hex")}`;
    const key = randomBytes(32);
    const target = databaseNamed("target");
    const sources = { alpha: databaseNamed("alpha"), beta: databaseNamed("beta") };
    try {
      await createDatabase(target);
      await migrate(target);
      for (const url of [sources.alpha, sources.beta]) {
        await createDatabase(url);
        await migrateLegacy(url);
      }
      await seedSource(sources.alpha, "Alpha", 1200);
      await seedSource(sources.beta, "Beta", 30);
      await withClient(sources.beta, (client) => client.query("CREATE TABLE retired_store(id int PRIMARY KEY)"));
      await withClient(target, (client) => client.query("CREATE TABLE runtime_store(id int PRIMARY KEY)"));
      const sourceTenants = Object.fromEntries(
        await Promise.all(
          Object.entries(sources).map(async ([name, url]) => [
            name,
            await withClient(url, async (client) => (await client.query("SELECT id::text FROM qm_tenant")).rows[0].id),
          ]),
        ),
      ) as Record<keyof typeof sources, string>;

      const lines: string[] = [];
      const run = (name: keyof typeof sources, staging: string, extra: { replace?: boolean; dryRun?: boolean } = {}) =>
        importTenant({
          sourceUrl: sources[name],
          stagingUrl: staging,
          targetUrl: target,
          slug: name,
          orgId: name,
          hosts: [`${name}.example.test`],
          dryRun: extra.dryRun ?? false,
          replace: extra.replace ?? false,
          allowExtraColumns: false,
          createStaging: true,
          batchSize: 100,
          migrate,
          writeTenant: (id, db) =>
            upsertTenant(
              db,
              {
                id,
                slug: name,
                orgId: name,
                hosts: [`${name}.example.test`],
                status: "active",
                oidcAdmin: false,
                secrets: {},
              },
              key,
            ),
          log: (line) => lines.push(line),
        });

      const dry = await run("alpha", databaseNamed("stage_dry"), { dryRun: true });
      assert.equal(dry.committed, false);
      const alpha = await run("alpha", databaseNamed("stage_alpha"));
      const beta = await run("beta", databaseNamed("stage_beta"));
      assert.ok(lines.some((line) => /only in the target.*runtime_store/.test(line)));
      assert.ok(lines.some((line) => /empty tables only in staging \(skipped\): retired_store/.test(line)));
      assert.equal(alpha.tenantId, sourceTenants.alpha);
      assert.equal(beta.tenantId, sourceTenants.beta);
      for (const result of [alpha, beta]) {
        assert.ok(result.tables.length > 10);
        for (const count of result.tables) assert.equal(count.target, count.staging, count.table);
      }
      assert.equal(alpha.tables.find((count) => count.table === "audit_log")?.target, 1200);
      assert.equal(beta.tables.find((count) => count.table === "directory_channels")?.target, 2);
      for (const result of [alpha, beta]) {
        assert.equal(result.tables.find((count) => count.table === "acl_grants")?.target, 1);
        assert.equal(result.tables.find((count) => count.table === "acl_grants_version")?.target, 1);
      }

      await withClient(target, async (client) => {
        await client.query(`CREATE ROLE ${appRole} NOSUPERUSER NOBYPASSRLS`);
        await client.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO ${appRole}`);
        await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);
        await client.query(`SET ROLE ${appRole}`);
        const visible = async (tenantId: string) => {
          await client.query("SELECT set_config('qm.tenant_id', $1, false)", [tenantId]);
          const channels = await client.query("SELECT name FROM directory_channels ORDER BY channel_id");
          const audits = await client.query("SELECT count(*)::int AS n FROM audit_log");
          return { names: channels.rows.map((row) => row.name), audits: audits.rows[0].n };
        };
        assert.deepEqual(await visible(alpha.tenantId), { names: ["Alpha", "Alpha"], audits: 1200 });
        assert.deepEqual(await visible(beta.tenantId), { names: ["Beta", "Beta"], audits: 30 });
        await client.query("SELECT set_config('qm.tenant_id', $1, false)", [beta.tenantId]);
        const inserted = await client.query(
          "INSERT INTO audit_log(at, principal_id, action, resource, scope_label) VALUES (1, 'p', 'a', 'r', 's') RETURNING id::int",
        );
        assert.ok(inserted.rows[0].id > 1200);
        const tenants = await client.query("SELECT slug, status FROM tenants ORDER BY slug");
        assert.deepEqual(tenants.rows, [
          { slug: "alpha", status: "active" },
          { slug: "beta", status: "active" },
        ]);
        await client.query("RESET ROLE");
      });

      await assert.rejects(run("alpha", databaseNamed("stage_again")), /already has rows for tenant/);
      const replaced = await run("alpha", databaseNamed("stage_replace"), { replace: true });
      assert.equal(replaced.tables.find((count) => count.table === "audit_log")?.target, 1200);
      await withClient(target, async (client) => {
        await client.query("SELECT set_config('qm.tenant_bypass', 'on', false)");
        const totals = await client.query(
          "SELECT tenant_id::text AS tenant, count(*)::int AS n FROM directory_channels GROUP BY tenant_id ORDER BY n",
        );
        assert.equal(totals.rows.length, 2);
        assert.ok(totals.rows.every((row) => row.n === 2));
      });
      await withClient(databaseNamed("stage_beta"), async (client) => {
        const schemas = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'cleanup_backup'");
        assert.equal(schemas.rowCount, 0);
      });
      await withClient(databaseNamed("stage_alpha"), async (client) => {
        const schemas = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'cleanup_backup'");
        assert.equal(schemas.rowCount, 0);
      });
      await withClient(sources.alpha, async (client) => {
        const untouched = await client.query("SELECT count(*)::int AS n FROM audit_log");
        assert.equal(untouched.rows[0].n, 1200);
      });
    } finally {
      await withClient(target, async (client) => {
        await client.query(`DROP OWNED BY ${appRole}`);
        await client.query(`DROP ROLE ${appRole}`);
      }).catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test("the import CLI takes the slim tenant spec and refuses an env-bag spec", () => {
  const run = (spec: object) =>
    spawnSync(
      process.execPath,
      [
        "src/tenant-import-main.ts",
        "--spec-env",
        "TENANT_SPEC",
        "--source-url",
        "postgres://127.0.0.1:1/source",
        "--staging-url",
        "postgres://127.0.0.1:1/source",
        "--target-url",
        "postgres://127.0.0.1:1/source",
      ],
      { env: { ...process.env, TENANT_SPEC: JSON.stringify(spec) }, encoding: "utf8" },
    );
  const bagged = run({ slug: "acme", orgId: "acme", env: { core: {} }, secretEnv: { core: {} } });
  assert.notEqual(bagged.status, 0);
  assert.match(bagged.stderr, /unknown field\(s\) env, secretEnv/);
  const straySecret = run({ slug: "acme", orgId: "acme", secrets: { coreSigningSecret: "x" } });
  assert.match(straySecret.stderr, /secrets: unknown field\(s\) coreSigningSecret/);
  const slim = run({
    slug: "acme",
    orgId: "acme",
    s3Bucket: "b",
    oidcAdmin: true,
    secrets: { adminGrants: "a:org_admin" },
  });
  assert.match(slim.stderr, /must be three different databases/);
});
