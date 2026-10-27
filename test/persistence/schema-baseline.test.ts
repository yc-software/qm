import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import { CONTRACT_MIGRATIONS, HELD_BACK_CONTRACT_MIGRATIONS } from "../../src/persistence/contract-migrations.ts";
import { applyPgMigrations, migrateRegisteredPgSchemas, pgMigrationFrom } from "../../src/persistence/pg-pool.ts";
import { SCHEMA_BASELINE } from "../../src/persistence/schema-baseline.ts";
import { TENANT_BYPASS_OPTION } from "../../src/persistence/tenancy.ts";
import { mergeTenantQueues } from "../../src/turns/absurd-schema.ts";
import { buildApp } from "../../src/wiring.ts";
import { testConfig } from "../support/test-config.ts";
import { withClient } from "../support/pg-client.ts";

// An upgraded database must end up with exactly the schema a fresh one gets from the baseline plus later migrations,
// once both have run the held-back contract migrations. The fixtures are pg_dump snapshots (schema, plus the ledger and
// tenant rows) of databases built and booted by real releases:
// - qm main v0.1.9 (95b5a6a9): before the qm_schema_migrations ledger, tables created on first use;
// - qm main v0.1.15 (7417aa2a): the last main release before the StyleUp line, 16 folded migrations short;
// - qm main 9be16d35: the release the baseline was cut from (single-tenant, prod-shaped);
// - qm 323baddc: StyleUp before the baseline (row-level tenancy, six tenants);
// - batch 20 (90d5c8f1): the line just before the baseline, with its own edits of already-run migrations;
// - StyleUp's current shape: 323baddc booted on batch 20, then on c1dc52b8 (batch 30, baseline recorded).

const base = process.env.DATABASE_URL!;
const created: string[] = [];

// Tables a sandbox backend creates when it is constructed, which depends on the environment that booted the fixture, and
// the ledger table of releases before qm_schema_migrations.
const BOOT_OR_LEGACY_TABLES = [
  "do_managed_agents_sandbox_bodies",
  "smolmachines_sandbox_bodies",
  "local_sandbox_bodies",
  "schema_migrations",
];

const FINGERPRINT = `
WITH ns AS (
  SELECT oid, nspname FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pgboss') AND nspname NOT LIKE 'pg\\_temp%'
    AND nspname NOT LIKE 'pg\\_toast\\_temp%'
), rel AS (
  SELECT c.oid, ns.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
)
SELECT line FROM (
  SELECT format('relation %s.%s kind=%s rls=%s force=%s', nspname, relname, relkind, relrowsecurity, relforcerowsecurity)
    FROM rel WHERE relkind IN ('r', 'p', 'v', 'm', 'S')
  UNION ALL
  SELECT format('column %s.%s.%s %s notnull=%s default=%s generated=%s identity=%s', r.nspname, r.relname, a.attname,
                format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attgenerated,
                a.attidentity)
    FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE r.relkind IN ('r', 'p', 'v', 'm')
  UNION ALL
  SELECT format('constraint %s.%s %s %s', r.nspname, r.relname, con.conname, pg_get_constraintdef(con.oid))
    FROM pg_constraint con JOIN rel r ON r.oid = con.conrelid
  UNION ALL
  SELECT format('index %s', pg_get_indexdef(i.indexrelid)) FROM pg_index i JOIN rel r ON r.oid = i.indrelid
  UNION ALL
  SELECT format('trigger %s', pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN rel r ON r.oid = t.tgrelid WHERE NOT t.tgisinternal
  UNION ALL
  SELECT format('policy %s.%s %s cmd=%s permissive=%s using=%s check=%s', r.nspname, r.relname, p.polname, p.polcmd,
                p.polpermissive, pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
    FROM pg_policy p JOIN rel r ON r.oid = p.polrelid
  UNION ALL
  SELECT format('function %s', pg_get_functiondef(p.oid))
    FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'p') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT format('view %s.%s %s', r.nspname, r.relname, pg_get_viewdef(r.oid)) FROM rel r WHERE r.relkind IN ('v', 'm')
  UNION ALL
  SELECT format('type %s.%s %s', ns.nspname, t.typname,
                (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid))
    FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
    WHERE t.typtype IN ('e', 'd', 'c') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')
  UNION ALL
  SELECT format('statistics %s.%s %s', ns.nspname, s.stxname, pg_get_statisticsobjdef_columns(s.oid))
    FROM pg_statistic_ext s JOIN ns ON ns.oid = s.stxnamespace
  UNION ALL
  SELECT format('extension %s', extname) FROM pg_extension
  UNION ALL
  SELECT format('sequence %s.%s %s', r.nspname, r.relname, format_type(s.seqtypid, NULL))
    FROM pg_sequence s JOIN rel r ON r.oid = s.seqrelid
) lines(line) ORDER BY line`;

function urlFor(name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(fixture?: string): Promise<string> {
  const name = `qm_baseline_${randomBytes(6).toString("hex")}`;
  await withClient(base, (client) => client.query(`CREATE DATABASE ${name}`));
  created.push(name);
  const url = urlFor(name);
  if (fixture) {
    const sql = gunzipSync(readFileSync(new URL(`../fixtures/schema-baseline/${fixture}`, import.meta.url))).toString();
    await withClient(url, (client) => client.query(sql));
  }
  return url;
}

async function migrate(url: string, multitenant: boolean): Promise<void> {
  const { runtime } = buildApp({
    anthropicApiKey: "test-anthropic-key",
    ...testConfig({ databaseUrl: url, multitenant }),
  });
  try {
    await migrateRegisteredPgSchemas(url);
    await mergeTenantQueues(url);
  } finally {
    await runtime.stop();
  }
}

async function fingerprint(url: string): Promise<string[]> {
  return withClient(url, async (client) => (await client.query<{ line: string }>(FINGERPRINT)).rows.map((r) => r.line));
}

async function copyTenants(from: string, to: string): Promise<void> {
  const rows = await withClient(from, async (client) => (await client.query("SELECT * FROM tenants")).rows);
  await withClient(to, async (client) => {
    for (const row of rows) {
      await client.query("INSERT INTO tenants(id, slug, org_id, hosts) VALUES ($1, $2, $3, $4)", [
        row.id,
        row.slug,
        row.org_id,
        row.hosts,
      ]);
    }
  });
}

async function applyContracts(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url, options: TENANT_BYPASS_OPTION });
  try {
    await applyPgMigrations(pool, [...CONTRACT_MIGRATIONS, ...HELD_BACK_CONTRACT_MIGRATIONS].map(pgMigrationFrom));
  } finally {
    await pool.end();
  }
}

async function assertSameSchema(upgradedUrl: string, freshUrl: string): Promise<void> {
  await applyContracts(upgradedUrl);
  await applyContracts(freshUrl);
  const upgraded = await fingerprint(upgradedUrl);
  const fresh = await fingerprint(freshUrl);
  const freshLines = new Set(fresh);
  const upgradedLines = new Set(upgraded);
  const bootTable = (line: string) =>
    BOOT_OR_LEGACY_TABLES.some((table) => new RegExp(`\\bpublic\\.${table}(\\b|_)`).test(line));
  assert.deepEqual(
    upgraded.filter((line) => !freshLines.has(line) && !bootTable(line)),
    [],
    "objects an upgraded database has that a fresh one lacks",
  );
  assert.deepEqual(
    fresh.filter((line) => !upgradedLines.has(line)),
    [],
    "objects a fresh database has that an upgraded one lacks",
  );
}

async function ledgerIds(url: string): Promise<Map<string, string>> {
  return withClient(
    url,
    async (client) =>
      new Map(
        (
          await client.query<{ id: string; checksum: string }>("SELECT id, checksum FROM qm_schema_migrations")
        ).rows.map((row) => [row.id, row.checksum] as const),
      ),
  );
}

async function upgradeSingleTenant(fixture: string): Promise<string> {
  const upgraded = await createDatabase(fixture);
  const fresh = await createDatabase();
  await migrate(upgraded, false);
  await migrate(fresh, false);
  await assertSameSchema(upgraded, fresh);
  return upgraded;
}

async function upgradeMultitenant(fixture: string): Promise<string> {
  const upgraded = await createDatabase(fixture);
  const fresh = await createDatabase();
  await migrate(upgraded, true);
  await migrate(fresh, true);
  await copyTenants(upgraded, fresh);
  await migrate(fresh, true);
  assert.ok((await fingerprint(upgraded)).some((line) => line.startsWith("policy public.items qm_tenant_isolation")));
  await assertSameSchema(upgraded, fresh);
  return upgraded;
}

function assertChainAndBaselineRecorded(ledger: Map<string, string>): void {
  for (const migration of SCHEMA_BASELINE.chain.migrations) {
    assert.ok(ledger.has(migration.id), `pre-baseline migration ${migration.id} is recorded`);
  }
  assert.equal(ledger.get(SCHEMA_BASELINE.id), SCHEMA_BASELINE.checksum);
}

after(async () => {
  await withClient(base, async (client) => {
    for (const name of created) await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
});

test("a database from before the migration ledger (v0.1.9) runs the whole pre-baseline chain", async () => {
  const upgraded = await upgradeSingleTenant("main-v0.1.9-95b5a6a9.sql.gz");
  assertChainAndBaselineRecorded(await ledgerIds(upgraded));
});

test("a database from main's last release before the line (v0.1.15) runs the pre-baseline migrations it lacks", async () => {
  const before = await createDatabase("main-v0.1.15-7417aa2a.sql.gz");
  const recorded = await ledgerIds(before);
  const lacking = SCHEMA_BASELINE.chain.migrations.filter((m) => !recorded.has(m.id)).map((m) => m.id);
  assert.equal(lacking.length, 16);
  assert.ok(lacking.includes("sessions/store/0035-items"));
  const upgraded = await upgradeSingleTenant("main-v0.1.15-7417aa2a.sql.gz");
  assertChainAndBaselineRecorded(await ledgerIds(upgraded));
});

test("a prod-shaped database from main 9be16d35 adopts the baseline and migrates to the fresh schema", async () => {
  const upgraded = await upgradeSingleTenant("main-9be16d35.sql.gz");
  assertChainAndBaselineRecorded(await ledgerIds(upgraded));
});

test("a database from the line before the baseline (batch 20) adopts it and migrates to the fresh schema", async () => {
  const upgraded = await upgradeSingleTenant("line-batch20-90d5c8f1.sql.gz");
  assertChainAndBaselineRecorded(await ledgerIds(upgraded));
});

test("a StyleUp multitenant database from before the baseline adopts it and keeps its tenancy", async () => {
  await upgradeMultitenant("styleup-323baddc.sql.gz");
});

test("a StyleUp database in its current shape migrates to the fresh schema", async () => {
  await upgradeMultitenant("styleup-c1dc52b8.sql.gz");
});

test("a tenantized database that lacks a folded migration keeps every tenant's tool calls through the chain", async () => {
  const url = await createDatabase("styleup-323baddc.sql.gz");
  const lacking = "durable-map/pinned_skills/0002-drop";
  await withClient(url, async (client) => {
    await client.query("SET qm.tenant_bypass = 'on'");
    await client.query("DELETE FROM qm_schema_migrations WHERE id = $1", [lacking]);
    const tenants = (await client.query<{ id: string }>("SELECT id FROM tenants ORDER BY id LIMIT 2")).rows;
    for (const tenant of tenants) {
      await client.query(
        "INSERT INTO tool_calls(tenant_id, run_id, attempt, call_index, output, created_at) VALUES ($1, 'run-1', 1, 0, 'out', 1)",
        [tenant.id],
      );
    }
  });
  await migrate(url, true);
  const rows = await withClient(url, async (client) => {
    await client.query("SET qm.tenant_bypass = 'on'");
    return (await client.query("SELECT tenant_id FROM tool_calls WHERE run_id = 'run-1'")).rows;
  });
  assert.equal(rows.length, 2);
  assert.ok((await ledgerIds(url)).has(lacking));
});

test("a pre-baseline migration recorded with another checksum refuses the run before anything is applied", async () => {
  const url = await createDatabase();
  const [first] = SCHEMA_BASELINE.chain.migrations;
  await withClient(url, async (client) => {
    await client.query(
      "CREATE TABLE qm_schema_migrations(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    await client.query("INSERT INTO qm_schema_migrations(id, checksum) VALUES ($1, 'x')", [first!.id]);
  });
  await assert.rejects(
    migrate(url, false),
    new RegExp(`refusing to migrate; nothing was applied: migration ${first!.id} checksum mismatch \\(database=x,`),
  );
  assert.deepEqual([...(await ledgerIds(url)).keys()], [first!.id]);
});
