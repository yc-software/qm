import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyPgMigrations, definePgMigration, type PgMigrationDefinition } from "../src/persistence/pg-pool.ts";
import { tenantTables } from "../src/tenants/migrations.ts";
import { testBareDatabaseUrl } from "./support/test-database.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenant expand adoption test";

const LEGACY = [
  "CREATE TABLE probe_parents(id TEXT PRIMARY KEY, label TEXT NOT NULL)",
  "CREATE TABLE probe_children(id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES probe_parents(id) ON DELETE CASCADE)",
  "INSERT INTO probe_parents VALUES ('p1', 'a'), ('p2', 'b')",
  "INSERT INTO probe_children VALUES ('c1', 'p1'), ('c2', 'p2')",
];

const STEPS = tenantTables(
  "probe/0001-tenants",
  [
    { table: "probe_parents", primaryKey: "id", unique: [] },
    { table: "probe_children", primaryKey: "id" },
  ],
  {
    references: [
      {
        table: "probe_children",
        name: "probe_children_parent_fkey",
        columns: "parent",
        references: "probe_parents(tenant_id, id)",
        onDelete: "CASCADE",
      },
    ],
  },
);

const EXPAND = /\/(0-column|2-keys|2-references)$|^0000-tenancy\/(base|settings|boot-tenant)$/;
const ADOPT = /\/(0-column|0-stamp-column|2-references|2-tenant-policy)$/;

const migrate = (pool: pg.Pool, steps: readonly PgMigrationDefinition[]) =>
  applyPgMigrations(pool, [...steps].sort((a, b) => a.id.localeCompare(b.id)).map(definePgMigration));

const shape = async (pool: pg.Pool) =>
  (
    await pool.query<{ item: string }>(
      `SELECT format('%s %s %s', conrelid::regclass, conname, pg_get_constraintdef(oid)) AS item
         FROM pg_constraint WHERE conrelid::regclass::text LIKE 'probe_%'
       UNION ALL SELECT format('%s %s', tablename, indexdef) FROM pg_indexes WHERE tablename LIKE 'probe_%'
       UNION ALL SELECT format('%s %s %s', tablename, policyname, qual) FROM pg_policies WHERE tablename LIKE 'probe_%'
       UNION ALL SELECT format('%s %s', table_name, column_default) FROM information_schema.columns
        WHERE table_name LIKE 'probe_%' AND column_name = 'tenant_id'
       ORDER BY 1`,
    )
  ).rows.map((row) => row.item);

const physical = async (pool: pg.Pool) => {
  const list = async (sql: string) => (await pool.query<{ item: string }>(sql)).rows.map((row) => row.item).sort();
  return {
    tables: await list(
      "SELECT format('%s %s', relname, relfilenode) AS item FROM pg_class WHERE relname LIKE 'probe_%' AND relkind = 'r'",
    ),
    indexes: await list(
      `SELECT i.indexrelid::text AS item FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
        WHERE c.relname LIKE 'probe_%'`,
    ),
    references: await list(
      `SELECT format('%s %s', oid, convalidated::text) AS item FROM pg_constraint
        WHERE contype = 'f' AND conrelid::regclass::text LIKE 'probe_%'`,
    ),
  };
};

const within = (subset: readonly string[], set: readonly string[]) =>
  assert.deepEqual(
    subset.filter((item) => !set.includes(item)),
    [],
  );

const withDatabase = async (fn: (pool: pg.Pool) => Promise<void>) => {
  const pool = new pg.Pool({ connectionString: testBareDatabaseUrl() });
  try {
    for (const statement of LEGACY) await pool.query(statement);
    await fn(pool);
  } finally {
    await pool.end();
  }
};

const policyShape = async () => {
  let fresh: string[] = [];
  await withDatabase(async (pool) => {
    await migrate(pool, STEPS);
    fresh = await shape(pool);
  });
  return fresh;
};

test("adopts tenant columns, keys and validated references built ahead without ledger rows", { skip }, async () => {
  const fresh = await policyShape();
  await withDatabase(async (pool) => {
    await migrate(
      pool,
      STEPS.filter(({ id }) => EXPAND.test(id)),
    );
    for (const [table, name] of [
      ["probe_parents", "probe_parents_tenant"],
      ["probe_children", "probe_children_tenant"],
      ["probe_children", "probe_children_parent_fkey_tenant"],
    ])
      await pool.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
    await pool.query("DELETE FROM qm_schema_migrations");
    const before = await physical(pool);
    await migrate(pool, STEPS);
    const after = await physical(pool);
    assert.deepEqual(after.tables, before.tables);
    within(after.indexes, before.indexes);
    within(after.references, before.references);
    assert.ok(after.references.every((item) => item.endsWith(" true")));
    assert.deepEqual(await shape(pool), fresh);
    const ledger = await pool.query(
      "SELECT id FROM qm_schema_migrations WHERE id LIKE 'probe/%-tenants/%' ORDER BY id",
    );
    assert.ok(ledger.rows.some((row) => row.id === "probe/0001-tenants/1-column"));
    assert.ok(ledger.rows.some((row) => row.id === "probe/0001-tenants/3-policy"));
  });
});

test("leaves a database migrated before the adopt steps unchanged", { skip }, async () => {
  const fresh = await policyShape();
  await withDatabase(async (pool) => {
    await migrate(
      pool,
      STEPS.filter(({ id }) => !ADOPT.test(id)),
    );
    const before = await physical(pool);
    await migrate(pool, STEPS);
    assert.deepEqual(await physical(pool), before);
    assert.deepEqual(await shape(pool), fresh);
  });
});
