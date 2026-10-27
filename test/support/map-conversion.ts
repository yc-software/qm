import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPgMigrations, definePgMigration, type PgMigrationDefinition } from "../../src/persistence/pg-pool.ts";
import { applyTenancy, TENANT_BYPASS_OPTION } from "../../src/persistence/tenancy.ts";
import {
  columnName,
  tableCodec,
  type ColumnType,
  type MapConversion,
  type TableSpec,
} from "../../src/persistence/typed-table.ts";
import { testDatabaseUrl } from "./test-database.ts";

type Json = Record<string, unknown>;
type Seed = [tenant: string | null, rows: ReadonlyArray<{ id: string; json: Json }>];

const SAMPLES: Record<ColumnType, (field: string, n: number) => unknown> = {
  text: (field, n) => `${field} ${n} \u00e9\u{1F600}`,
  bigint: (_field, n) => 1_761_000_000_000 + n,
  "double precision": (_field, n) => n + 0.5,
  boolean: (_field, n) => n % 2 === 0,
  jsonb: (field, n) => ({ field, list: [n, "x", { deep: null }], ok: true }),
  "text[]": (field, n) => [`${field}-${n}`, "b"],
};

function sampleRows(spec: TableSpec, dropKeys: readonly string[]) {
  return [1, 2].map((n) => {
    const id = `${spec.table}-${n}`;
    const json: Json = spec.keyIsField ? { [spec.key]: id } : {};
    for (const [field, c] of Object.entries(spec.columns))
      if (n === 1 || c.required) json[field] = SAMPLES[c.type](field, n);
    const want = { ...json };
    for (const key of n === 1 ? dropKeys : []) json[key] = `legacy ${key}`;
    return { id, json, want };
  });
}

async function seedMap(pool: pg.Pool, table: string, seeds: readonly Seed[]) {
  await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
  await pool.query(`CREATE INDEX ${table}_ownerscopeid_fold ON ${table} USING hash (lower(json->>'ownerScopeId'))`);
  await pool.query(
    `CREATE INDEX ${table}_ownerscopeid_unicode ON ${table} (id) WHERE json->>'ownerScopeId' ~ '[^\\x01-\\x7f]'`,
  );
  await pool.query(`CREATE STATISTICS ${table}_ownerscopeid_stats ON (json->>'ownerScopeId') FROM ${table}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`);
  if (seeds[0]![0]) await applyTenancy(pool);
  for (const [tenant, rows] of seeds) {
    const cols = tenant ? "tenant_id, " : "";
    const args = tenant ? [tenant] : [];
    const at = tenant ? "$1, $2" : "$1";
    for (const row of rows)
      await pool.query(`INSERT INTO ${table} (${cols}id, json) VALUES (${at}, $${args.length + 2})`, [
        ...args,
        row.id,
        row.json,
      ]);
    await pool.query(`INSERT INTO durable_map_versions (${cols}tbl, v) VALUES (${at}, 7) ON CONFLICT DO NOTHING`, [
      ...args,
      table,
    ]);
  }
}

async function runMigration(pool: pg.Pool, migration: PgMigrationDefinition) {
  await pool.query(`DELETE FROM qm_schema_migrations WHERE id = $1`, [migration.id]);
  await applyPgMigrations(pool, [definePgMigration(migration.id, migration.statements)]);
  for (const statement of migration.statements) await pool.query(statement);
}

const stripNulls = (json: Json) => Object.fromEntries(Object.entries(json).filter(([, v]) => v !== null));

async function assertDualWrites(pool: pg.Pool, conversion: MapConversion, sample: { json: Json; want: Json }) {
  const { spec } = conversion;
  const codec = tableCodec<Json>(spec);
  const keyed = (id: string, json: Json) => ({ ...json, ...(spec.keyIsField ? { [spec.key]: id } : {}) });
  const client = await pool.connect();
  const read = async (id: string) =>
    (
      await client.query(`SELECT id, json, ${codec.columns} FROM ${spec.table} WHERE ${columnName(spec.key)} = $1`, [
        id,
      ])
    ).rows[0];
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM ${spec.table}`);
    await client.query(`INSERT INTO ${spec.table} (id, json) VALUES ('old-writer', $1)`, [
      keyed("old-writer", sample.json),
    ]);
    assert.deepEqual(codec.row(await read("old-writer")), keyed("old-writer", sample.want));
    await client.query(`DELETE FROM ${spec.table}`);
    const record = keyed("new-writer", sample.want);
    await client.query(
      `INSERT INTO ${spec.table} (${codec.columns}) VALUES (${codec.placeholders})`,
      codec.values("new-writer", record),
    );
    const fromNew = await read("new-writer");
    assert.equal(fromNew.id, "new-writer", `${spec.table} keeps the old key column in step`);
    assert.deepEqual(stripNulls(fromNew.json), record, `${spec.table} keeps json in step for older readers`);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

export async function assertMapConversion(conversion: MapConversion): Promise<void> {
  const { spec } = conversion;
  const codec = tableCodec<Json>(spec);
  const rows = sampleRows(spec, conversion.dropKeys);
  const wanted = new Map(rows.map((row) => [row.id, row.want]));
  const cases: Seed[][] = [
    [[null, rows]],
    [
      [randomUUID(), rows],
      [randomUUID(), rows.slice(1)],
    ],
  ];
  const typedRows = async (pool: pg.Pool, tenant: string | null) =>
    codec.rows(
      (
        await pool.query(
          `SELECT ${codec.columns} FROM ${spec.table} ${tenant ? "WHERE tenant_id = $1" : ""} ORDER BY ${columnName(spec.key)}`,
          tenant ? [tenant] : [],
        )
      ).rows,
    );
  for (const seeds of cases) {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), options: TENANT_BYPASS_OPTION });
    try {
      await seedMap(pool, spec.table, seeds);
      await runMigration(pool, conversion);
      for (const [tenant, seeded] of seeds) {
        const want = seeded.map((row) => wanted.get(row.id));
        assert.deepEqual(await typedRows(pool, tenant), want, `${spec.table} typed rows for tenant ${tenant}`);
        const json = await pool.query(
          `SELECT json FROM ${spec.table} ${tenant ? "WHERE tenant_id = $1" : ""} ORDER BY id`,
          tenant ? [tenant] : [],
        );
        assert.deepEqual(
          json.rows.map((row) => row.json),
          seeded.map((row) => row.json),
          `${spec.table} json untouched`,
        );
      }
      if (!seeds[0]![0]) await assertDualWrites(pool, conversion, rows[0]!);
      await runMigration(pool, conversion.contract);
      const json = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name IN ('json', 'id')`,
        [spec.table],
      );
      assert.equal(json.rowCount, columnName(spec.key) === `"id"` ? 1 : 0, `${spec.table} contract drops json`);
      assert.equal(
        (await pool.query(`SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [spec.table]))
          .rowCount,
        0,
        `${spec.table} contract drops the sync and bump triggers`,
      );
      for (const [tenant, seeded] of seeds)
        assert.deepEqual(
          await typedRows(pool, tenant),
          seeded.map((row) => wanted.get(row.id)),
          `${spec.table} after contract`,
        );
    } finally {
      await pool.end();
    }
  }
}
