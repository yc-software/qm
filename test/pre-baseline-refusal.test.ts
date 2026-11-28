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

function migrate(url: string, dataDir: string) {
  return promisify(execFile)(process.execPath, ["src/migrate-main.ts"], {
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

const load = async (db: pg.Pool, f: string) =>
  db.query(
    `${gunzipSync(await readFile(new URL(`./fixtures/${f}`, import.meta.url)))}SET search_path = "$user", public`,
  );
for (const fixture of [
  "v0.1.16-seeded.sql.gz",
  "v0.1.15-after-failed-0.1.16.sql.gz",
  "v0.1.15-after-failed-0.1.16-and-0.1.17.sql.gz",
])
  test(
    `startup refuses ${fixture}, which predates the baseline, names what it is missing and leaves it untouched`,
    { skip: !databaseUrl, timeout: 900_000 },
    async () => {
      const admin = new pg.Pool({ connectionString: ownerUrl(databaseUrl!).toString(), max: 1 });
      const dataDir = await mkdtemp(join(tmpdir(), "qm-upgrade-test-"));
      try {
        await withDatabase(admin, async (url, db) => {
          await load(db, fixture);
          const schema = (await db.query<{ entry: string }>(SCHEMA_SNAPSHOT)).rows.map(({ entry }) => entry);
          const rows = await rowCounts(db);
          await assert.rejects(migrate(url, dataDir), (error: { stderr?: string }) => {
            assert.match(
              error.stderr ?? "",
              /schema replaces \d+ earlier migrations, but this database is missing \d+ of them \(0000-tenancy\/[^)]*\); upgrade it with the last QM release that still shipped them first/,
            );
            return true;
          });
          assert.deepEqual(
            (await db.query<{ entry: string }>(SCHEMA_SNAPSHOT)).rows.map(({ entry }) => entry),
            schema,
          );
          assert.deepEqual(await rowCounts(db), rows);
        });
      } finally {
        await rm(dataDir, { recursive: true, force: true });
        await admin.end();
      }
    },
  );
