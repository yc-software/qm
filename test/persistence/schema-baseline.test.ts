import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { SCHEMA_BASELINE } from "../../src/persistence/schema-baseline.ts";
import { tenantFor, withTenant } from "../../src/tenant.ts";
import { ensureTenantQueues } from "../../src/turns/absurd-schema.ts";
import { buildApp } from "../../src/wiring.ts";
import { testConfig } from "../support/test-config.ts";
import { withClient } from "../support/pg-client.ts";

// An upgraded database must end up with exactly the schema a fresh one gets from the baseline plus later migrations.
// The fixtures are pg_dump snapshots (schema, plus the ledger and tenant rows) of databases built and booted by real
// releases: qm main at 9be16d35 (single-tenant, prod-shaped) and qm 323baddc (StyleUp: row-level tenancy, six tenants).

const base = process.env.DATABASE_URL!;
const created: string[] = [];

// Tables an upgraded database keeps that a fresh migration here does not create: durable maps main still had and this
// build dropped without a migration, maps the sandbox layer creates at boot, and the local sandbox backend's map (the
// fixtures booted with SANDBOX_BACKEND=local).
const BOOT_OR_RETIRED_TABLES = [
  "do_managed_agents_sandbox_bodies",
  "loop_ingress",
  "loop_ingress_deliveries",
  "loop_outputs",
  "loop_ship_grants",
  "smolmachines_sandbox_bodies",
  "sandbox_resource_rollout",
  "sandbox_routing",
  "local_sandbox_bodies",
  // Kept for older images until the contract migrations drop them.
  "deliveries",
  "model_registry",
  "approved_harness_configs",
  "swarms",
];
const RETIRED_INDEXES = [
  "loop_items_loopid_fold",
  "loop_items_loopid_unicode",
  "loop_items_loopid_stats",
  "idx_runs_fair_key",
];
// Columns a StyleUp build added and this line stopped using without dropping (the per-owner turn cap's fair_key).
const RETIRED_COLUMNS = ["public.runs.fair_key ", "public.tenants.env ", "public.tenants.secret_env "];

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

// What a boot does to the schema: every registered migration, then each tenant's turn queues.
async function migrate(url: string, multitenant: boolean): Promise<void> {
  const { runtime } = buildApp({
    anthropicApiKey: "test-anthropic-key",
    ...testConfig({ databaseUrl: url, multitenant }),
  });
  try {
    await migrateRegisteredPgSchemas(url);
    if (!multitenant) return;
    const tenants = await withClient(url, async (client) => {
      await client.query("SET qm.tenant_bypass = 'on'");
      return (await client.query<{ id: string; slug: string; org_id: string }>("SELECT id, slug, org_id FROM tenants"))
        .rows;
    });
    for (const t of tenants) await withTenant(tenantFor(t.org_id, t.id, t.slug), () => ensureTenantQueues(url));
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

function assertSameSchema(upgraded: string[], fresh: string[]): void {
  const freshLines = new Set(fresh);
  const upgradedLines = new Set(upgraded);
  const retired = (line: string) =>
    BOOT_OR_RETIRED_TABLES.some((table) => new RegExp(`\\bpublic\\.${table}(\\b|_)`).test(line)) ||
    RETIRED_INDEXES.some((index) => line.includes(` ${index} `) || line.includes(`.${index} `)) ||
    RETIRED_COLUMNS.some((column) => line.startsWith(`column ${column}`));
  assert.deepEqual(
    upgraded.filter((line) => !freshLines.has(line) && !retired(line)),
    [],
    "objects an upgraded database has that a fresh one lacks",
  );
  assert.deepEqual(
    fresh.filter((line) => !upgradedLines.has(line)),
    [],
    "objects a fresh database has that an upgraded one lacks",
  );
}

after(async () => {
  await withClient(base, async (client) => {
    for (const name of created) await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
});

test("a prod-shaped database from main 9be16d35 adopts the baseline and migrates to the fresh schema", async () => {
  const upgraded = await createDatabase("main-9be16d35.sql.gz");
  const fresh = await createDatabase();
  await migrate(upgraded, false);
  await migrate(fresh, false);
  assertSameSchema(await fingerprint(upgraded), await fingerprint(fresh));
  const ledger = await withClient(
    upgraded,
    async (client) =>
      (await client.query("SELECT checksum FROM qm_schema_migrations WHERE id = $1", [SCHEMA_BASELINE.id])).rows,
  );
  assert.deepEqual(ledger, [{ checksum: SCHEMA_BASELINE.checksum }], "the baseline was adopted, not applied");
});

test("a StyleUp multitenant database adopts the baseline and keeps its tenancy", async () => {
  const upgraded = await createDatabase("styleup-323baddc.sql.gz");
  const fresh = await createDatabase();
  await migrate(upgraded, true);
  await migrate(fresh, true);
  await copyTenants(upgraded, fresh);
  await migrate(fresh, true);
  const lines = await fingerprint(upgraded);
  assert.ok(lines.some((line) => line.startsWith("policy public.items qm_tenant_isolation")));
  assertSameSchema(lines, await fingerprint(fresh));
});

test("a database older than the baseline is refused with what it lacks", async () => {
  const url = await createDatabase();
  await withClient(url, async (client) => {
    await client.query(
      "CREATE TABLE qm_schema_migrations(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    await client.query("INSERT INTO qm_schema_migrations(id, checksum) VALUES ('sessions/store/0001', 'x')");
  });
  await assert.rejects(
    migrate(url, false),
    /predates baseline baseline\/0001: \d+ of the \d+ migrations folded into it never ran/,
  );
});

test("a database with QM tables but no migration history is refused", async () => {
  const url = await createDatabase();
  await withClient(url, (client) => client.query("CREATE TABLE sessions(id TEXT PRIMARY KEY)"));
  await assert.rejects(migrate(url, false), /has QM tables but no qm_schema_migrations history/);
});
