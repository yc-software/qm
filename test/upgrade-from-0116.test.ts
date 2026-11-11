import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import pg from "pg";
import { ownerUrl } from "./support/test-tenant.ts";

const databaseUrl = process.env.DATABASE_URL;
const root = fileURLToPath(new URL("..", import.meta.url));
const RELEASE_TENANT = "5870d898-0d55-4acc-bfc6-7beb49f91455";
const REPLACED_TABLES = new Set([
  "public.acl_grants_version",
  "public.deployment_identity",
  "public.durable_map_versions",
  "public.principal_links",
  "public.qm_schema_migrations",
  "public.qm_tenant",
  "public.retired_tenant_hosts",
  "public.session_leases",
  "public.tenant_hosts",
]);

const SCHEMA_SNAPSHOT = `
  WITH rels AS (
    SELECT c.oid, n.nspname || '.' || regexp_replace(c.relname, '_[0-9]{8}', '_N', 'g') AS name, c.relkind,
           c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'pgboss') AND c.relkind IN ('r', 'p', 'v', 'S', 'i')
  )
  SELECT DISTINCT entry FROM (
    SELECT format('rel %s %s rls=%s/%s', name, relkind, relrowsecurity, relforcerowsecurity) AS entry FROM rels
    UNION ALL
    SELECT format('col %s %s %s %s %s %s', r.name, row_number() OVER (PARTITION BY r.oid ORDER BY a.attnum), a.attname, format_type(a.atttypid, a.atttypmod),
                  a.attnotnull, pg_get_expr(d.adbin, d.adrelid))
      FROM rels r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    UNION ALL
    SELECT format('con %s %s %s %s', r.name, regexp_replace(k.conname, '_[0-9]{8}', '_N', 'g'), pg_get_constraintdef(k.oid),
                  k.convalidated)
      FROM rels r JOIN pg_constraint k ON k.conrelid = r.oid AND k.contype <> 'n'
    UNION ALL
    SELECT format('idx %s', regexp_replace(pg_get_indexdef(i.indexrelid), '_[0-9]{8}', '_N', 'g'))
      FROM rels r JOIN pg_index i ON i.indrelid = r.oid
    UNION ALL
    SELECT format('pol %s %s %s %s', r.name, p.polname, pg_get_expr(p.polqual, p.polrelid),
                  pg_get_expr(p.polwithcheck, p.polrelid))
      FROM rels r JOIN pg_policy p ON p.polrelid = r.oid
    UNION ALL
    SELECT format('trg %s', pg_get_triggerdef(t.oid))
      FROM rels r JOIN pg_trigger t ON t.tgrelid = r.oid AND NOT t.tgisinternal
    UNION ALL
    SELECT format('fn %s', pg_get_functiondef(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'pgboss') AND p.prokind = 'f'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  ) entries ORDER BY entry`;

const ROW_COUNTS = `
  SELECT format('%I.%I', schemaname, relname) AS name, (xpath('/row/n/text()',
         query_to_xml(format('SELECT count(*) AS n FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::int AS n
    FROM pg_stat_user_tables WHERE schemaname = 'public'`;

async function migrate(url: string, dataDir: string): Promise<void> {
  const { stdout } = await promisify(execFile)(process.execPath, ["src/migrate-main.ts"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: url,
      SANDBOX_BACKEND: "local",
      CONNECTOR_SECRET_KEY: "upgrade-test-connector-secret",
      CAPABILITY_SECRET: "upgrade-test-capability-secret",
      DATA_DIR: dataDir,
    },
    timeout: 240_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.match(stdout, /\[qm:migrate\] database migrations applied/);
}

async function withDatabase<T>(admin: pg.Pool, run: (url: string, db: pg.Pool) => Promise<T>): Promise<T> {
  const name = `upgrade_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  const url = ownerUrl(databaseUrl!);
  url.pathname = `/${name}`;
  const db = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    return await run(url.toString(), db);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE ${name}`);
  }
}

async function rowCounts(db: pg.Pool): Promise<Map<string, number>> {
  const { rows } = await db.query<{ name: string; n: number }>(ROW_COUNTS);
  return new Map(rows.map(({ name, n }) => [name, n]));
}

const CASES = [
  {
    name: "a seeded v0.1.16 database",
    fixture: "v0.1.16-seeded.sql.gz",
    tenant: RELEASE_TENANT,
    populated: "public.sessions",
  },
  {
    name: "a v0.1.15 database left by a failed v0.1.16 upgrade",
    fixture: "v0.1.15-after-failed-0.1.16.sql.gz",
    baseline: "v0.1.15-seeded.sql.gz",
    populated: "public.channel_messages",
  },
  {
    name: "a v0.1.15 database left by failed v0.1.16 and v0.1.17 upgrades",
    fixture: "v0.1.15-after-failed-0.1.16-and-0.1.17.sql.gz",
    baseline: "v0.1.15-seeded.sql.gz",
    populated: "public.channel_messages",
  },
] as const satisfies readonly {
  name: string;
  fixture: string;
  baseline?: string;
  tenant?: string;
  populated: string;
}[];

async function loadFixture(db: pg.Pool, fixture: string): Promise<void> {
  await db.query(gunzipSync(await readFile(new URL(`./fixtures/${fixture}`, import.meta.url))).toString("utf8"));
  await db.query("SELECT pg_catalog.set_config('search_path', '\"$user\", public', false)");
}

for (const upgrade of CASES)
  test(
    `${upgrade.name} upgrades to the fresh tenant-keyed schema and keeps its rows`,
    { skip: !databaseUrl, timeout: 900_000 },
    async () => {
      const admin = new pg.Pool({ connectionString: ownerUrl(databaseUrl!).toString(), max: 1 });
      const dataDir = await mkdtemp(join(tmpdir(), "qm-upgrade-test-"));
      try {
        const fresh = await withDatabase(admin, async (url, db) => {
          if ("baseline" in upgrade) await loadFixture(db, upgrade.baseline);
          await migrate(url, dataDir);
          return (await db.query<{ entry: string }>(SCHEMA_SNAPSHOT)).rows.map(({ entry }) => entry);
        });
        await withDatabase(admin, async (url, db) => {
          await loadFixture(db, upgrade.fixture);
          const before = await rowCounts(db);
          if (before.has("public.participants")) {
            const closed = await db.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM participants WHERE valid_to IS NOT NULL OR valid_to_seq IS NOT NULL",
            );
            before.set("public.participants", before.get("public.participants")! - closed.rows[0]!.n);
          }
          await migrate(url, dataDir);
          await migrate(url, dataDir);
          const upgraded = (await db.query<{ entry: string }>(SCHEMA_SNAPSHOT)).rows.map(({ entry }) => entry);
          assert.deepEqual(
            upgraded.filter((entry) => !fresh.includes(entry)),
            fresh.filter((entry) => !upgraded.includes(entry)),
          );
          assert.deepEqual(upgraded, fresh);

          const after = await rowCounts(db);
          for (const [name, count] of before) {
            if (
              REPLACED_TABLES.has(name) ||
              name === "public.tenants" ||
              !fresh.some((e) => e.startsWith(`rel ${name} r `))
            )
              continue;
            assert.equal(after.get(name), count, `${name} kept its rows`);
          }
          assert.ok((before.get(upgrade.populated) ?? 0) > 0);
          const { rows: tenants } = await db.query<{ id: string }>("SELECT id FROM tenants");
          assert.equal(tenants.length, 1);
          const tenant = tenants[0]!.id;
          if ("tenant" in upgrade) assert.equal(tenant, upgrade.tenant);
          const { rows: tables } = await db.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name <> 'tenants'`,
          );
          assert.ok(tables.length > 100);
          for (const { table_name } of tables) {
            const { rows } = await db.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM ${table_name} WHERE tenant_id IS DISTINCT FROM $1`,
              [tenant],
            );
            assert.equal(rows[0]!.n, 0, `${table_name} rows stay with the release tenant`);
          }
        });
      } finally {
        await rm(dataDir, { recursive: true, force: true });
        await admin.end();
      }
    },
  );
