import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { legacyKeys, prebuildLegacyKeys, registeredTenantMigrations } from "../scripts/ops/tenant-prebuild.ts";
import { applyPgMigrations, type PgMigration } from "../src/persistence/pg-pool.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl, testMigratedDatabaseUrl } from "./support/test-database.ts";

const isTenancy = (migration: PgMigration): boolean =>
  /-(lookups|swap)$/.test(migration.id) ||
  migration.statements.some(
    (statement) => statement.includes("$tenant_column$") || /^ALTER TABLE .* FOREIGN KEY \(tenant_id/s.test(statement),
  );

const SCHEMA = `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL SELECT conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  ORDER BY 1`;

const OLD_KEY_UNIQUES = `SELECT c.relname || ': ' || pg_get_indexdef(i.indexrelid) AS def
   FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   JOIN pg_attribute t ON t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped
  WHERE n.nspname = 'public' AND i.indisunique AND i.indkey[0] <> t.attnum AND c.relname <> 'tenant_hosts'
  ORDER BY 1`;

describe("tenant legacy key prebuild", () => {
  let migrations: readonly PgMigration[] = [];
  const pools: pg.Pool[] = [];
  const pool = (url: string): pg.Pool => {
    const created = new pg.Pool({ connectionString: url, max: 2 });
    pools.push(created);
    return created;
  };

  before(async () => {
    migrations = await registeredTenantMigrations({
      anthropicApiKey: "test-anthropic-key",
      ...testConfig({ databaseUrl: testDatabaseUrl() }),
    });
  });

  after(async () => {
    await Promise.all(pools.map((created) => created.end()));
  });

  async function prebuild(db: pg.Pool, dryRun = false): Promise<void> {
    const client = await db.connect();
    try {
      await prebuildLegacyKeys(client, migrations, { dryRun });
    } finally {
      client.release();
    }
  }

  async function legacyOids(db: pg.Pool): Promise<Record<string, string>> {
    const { rows } = await db.query<{ name: string; oid: string }>(
      `SELECT c.relname AS name, c.oid::text AS oid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = ANY($1) AND i.indisvalid AND i.indisunique`,
      [legacyKeys(migrations).map(({ name }) => name)],
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.oid]));
  }

  it("keeps the previous release's keyless writes working through the full migration", async () => {
    const db = pool(testDatabaseUrl());
    await applyPgMigrations(
      db,
      migrations.filter((migration) => !isTenancy(migration)),
    );
    const names = legacyKeys(migrations).map(({ name }) => name);
    for (const name of ["sessions_legacy_id_key", "sessions_legacy_thread_ref_key", "crons_legacy_id_key"])
      assert.ok(names.includes(name), name);
    assert.ok(names.includes("durable_map_versions_legacy_tbl_key"));

    const untouched = (await db.query(SCHEMA)).rows;
    await prebuild(db, true);
    assert.deepEqual((await db.query(SCHEMA)).rows, untouched);

    await prebuild(db);
    await prebuild(db);
    const built = await legacyOids(db);
    assert.ok(Object.keys(built).length > 50);
    assert.ok(built.sessions_legacy_id_key && built.durable_map_versions_legacy_tbl_key);

    await applyPgMigrations(db, migrations);
    assert.deepEqual(await legacyOids(db), built);

    const tenant = String((await db.query("SELECT id::text AS id FROM tenants")).rows[0]?.id);
    const twice = async (sql: string, params: unknown[] = []) => {
      await db.query(sql, params);
      await db.query(sql, params);
    };
    await twice(
      `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ('s1', 'dm', 'personal:u', 't1', 0)
       ON CONFLICT (id) DO UPDATE SET title = 'again'`,
    );
    await twice(
      `INSERT INTO sessions(id, type, scope_id, thread_ref, created_at) VALUES ('s2', 'dm', 'personal:u', 't1', 0)
       ON CONFLICT (thread_ref) DO NOTHING`,
    );
    await twice(
      `INSERT INTO crons(id, json) VALUES ('c1', '{"n": 1}') ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json`,
    );
    await twice(
      `INSERT INTO durable_map_versions(tbl, v) VALUES ('crons', 1)
       ON CONFLICT (tbl) DO UPDATE SET v = durable_map_versions.v + 1`,
    );
    await twice(
      `INSERT INTO deliveries(id, idempotency_key, destination, text, created_at) VALUES ($1, 'k1', '{}', 'hi', 0)
       ON CONFLICT (idempotency_key) DO UPDATE SET text = EXCLUDED.text`,
      [randomUUID()],
    );
    const runId = randomUUID();
    await twice(
      `INSERT INTO runs(id, session_id, status, request, idempotency_key, attempts, max_attempts, created_at)
       VALUES ($1, 's1', 'pending', '{}', 'r1', 0, 1, 0) ON CONFLICT (id) DO NOTHING`,
      [runId],
    );
    await twice(
      `INSERT INTO acl_grants(owner_scope_id, path, grantee_scope_id, permission, granted_by)
       VALUES ('personal:u', 'skill:s', 'personal:v', 'use', 'u')
       ON CONFLICT (owner_scope_id, path, grantee_scope_id, permission) DO UPDATE SET granted_by = EXCLUDED.granted_by`,
    );
    const stamped = await db.query(
      `SELECT 'sessions' AS t, count(*)::int AS n, array_agg(DISTINCT tenant_id::text) AS tenants FROM sessions
       UNION ALL SELECT 'crons', count(*)::int, array_agg(DISTINCT tenant_id::text) FROM crons
       UNION ALL SELECT 'durable_map_versions', count(*)::int, array_agg(DISTINCT tenant_id::text)
         FROM durable_map_versions WHERE tbl = 'crons'
       UNION ALL SELECT 'deliveries', count(*)::int, array_agg(DISTINCT tenant_id::text) FROM deliveries
       UNION ALL SELECT 'runs', count(*)::int, array_agg(DISTINCT tenant_id::text) FROM runs
       UNION ALL SELECT 'acl_grants', count(*)::int, array_agg(DISTINCT tenant_id::text) FROM acl_grants`,
    );
    for (const row of stamped.rows) assert.deepEqual([row.n, row.tenants], [1, [tenant]], String(row.t));
  });

  it("leaves no old-key unique index after a plain migration", async () => {
    const db = pool(testMigratedDatabaseUrl());
    assert.deepEqual(
      (await db.query(OLD_KEY_UNIQUES)).rows.map((row) => row.def),
      [],
    );
  });
});
