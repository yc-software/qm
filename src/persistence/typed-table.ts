import {
  tenantCols,
  tenantLockKey,
  withPgTransaction,
  type PgMigrationDefinition,
  type PgPool,
  type Rows,
} from "./pg-pool.ts";
import { jsonbStringify, pgTextSafe } from "../util/text.ts";

export type ColumnType = "text" | "bigint" | "double precision" | "boolean" | "jsonb" | "text[]";

export interface ColumnSpec {
  type: ColumnType;
  required?: boolean;
}

export interface TableSpec {
  table: string;
  key: string;
  keyIsField?: boolean;
  columns: Readonly<Record<string, ColumnSpec>>;
}

export interface MapConversion extends PgMigrationDefinition {
  spec: TableSpec;
  dropKeys: readonly string[];
  contract: PgMigrationDefinition;
}

const COLUMN_TYPES: Record<string, ColumnType> = {
  text: "text",
  bigint: "bigint",
  float: "double precision",
  boolean: "boolean",
  jsonb: "jsonb",
  "text[]": "text[]",
};

export function cols(defs: string): Record<string, ColumnSpec> {
  return Object.fromEntries(
    defs
      .split(",")
      .map((def) => def.trim().split(/\s+/))
      .map(([field, raw]) => {
        const type = COLUMN_TYPES[raw!.replace(/!$/, "")];
        if (!field || !type) throw new Error(`bad column definition: ${field} ${raw}`);
        return [field, raw!.endsWith("!") ? { type, required: true } : { type }];
      }),
  );
}

export const columnName = (field: string): string => `"${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}"`;

function fromJson(source: string, field: string, type: ColumnType): string {
  const v = `${source}->'${field}'`;
  const when = (kind: string, expr: string) => `CASE WHEN jsonb_typeof(${v}) = '${kind}' THEN ${expr} END`;
  switch (type) {
    case "text":
      return when("string", `${source}->>'${field}'`);
    case "bigint":
      return when("number", `round((${source}->>'${field}')::numeric)::bigint`);
    case "double precision":
      return when("number", `(${source}->>'${field}')::float8`);
    case "boolean":
      return when("boolean", `(${v})::boolean`);
    case "jsonb":
      return `CASE WHEN jsonb_typeof(${v}) <> 'null' THEN ${v} END`;
    case "text[]":
      return when("array", `ARRAY(SELECT jsonb_array_elements_text(${v}))`);
  }
}

function shape(spec: TableSpec) {
  const keyCol = columnName(spec.key);
  const cols = Object.entries(spec.columns).map(([field, c]) => ({ field, col: columnName(field), ...c }));
  const fields = (row: string, key: string) => [
    ...(spec.keyIsField ? [`'${spec.key}', to_jsonb(${key})`] : []),
    ...cols.map((c) => `'${c.field}', to_jsonb(${row}${c.col})`),
  ];
  return { keyCol, renamed: keyCol !== `"id"`, cols, fields };
}

const conversions = new Map<string, MapConversion>();

export const mapConversions = (): MapConversion[] => [...conversions.values()];

export function mapToTableMigration(
  id: string,
  spec: TableSpec,
  opts: { dropKeys?: readonly string[]; statements?: readonly string[] } = {},
): MapConversion {
  const { table } = spec;
  const { keyCol, renamed, cols, fields } = shape(spec);
  const all = renamed ? [...cols, { col: keyCol, type: "text", required: true, field: spec.key }] : cols;
  const required = all.filter((c) => c.required);
  const dropKeys = `ARRAY[${(opts.dropKeys ?? []).map((k) => `'${k}'`).join(", ")}]::text[]`;
  const keyIndex = `${table}_${keyCol.slice(1, -1)}_key`;
  const expand = `DO $expand$ DECLARE bad text; old record; BEGIN
      FOR old IN SELECT indexrelid::regclass::text AS name FROM pg_index
        WHERE indrelid = '${table}'::regclass AND NOT indisprimary AND pg_get_indexdef(indexrelid) LIKE '%json%'
      LOOP EXECUTE 'DROP INDEX ' || old.name; END LOOP;
      FOR old IN SELECT stxname AS name FROM pg_statistic_ext WHERE stxrelid = '${table}'::regclass
      LOOP EXECUTE format('DROP STATISTICS %I', old.name); END LOOP;
      ALTER TABLE ${table} ${all.map((c) => `ADD COLUMN IF NOT EXISTS ${c.col} ${c.type}`).join(", ")};
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${table}'::regclass AND tgname = '${table}_sync') THEN
        UPDATE ${table} SET ${[
          ...cols.map((c) => `${c.col} = ${fromJson("json", c.field, c.type)}`),
          ...(renamed ? [`${keyCol} = id`] : []),
        ].join(", ")};
      END IF;
      SELECT id INTO bad FROM ${table}
       WHERE jsonb_typeof(json) <> 'object'${required.map((c) => ` OR ${c.col} IS NULL`).join("")}
          OR jsonb_strip_nulls(json) - ${dropKeys} IS DISTINCT FROM jsonb_strip_nulls(jsonb_build_object(${fields("", "id").join(", ")}))
             - ARRAY(SELECT k FROM unnest(ARRAY['${spec.key}']) k WHERE NOT json ? k)
       LIMIT 1;
      IF bad IS NOT NULL THEN RAISE EXCEPTION '${table}: row % does not convert to typed columns', bad; END IF;
      ${required.length ? `ALTER TABLE ${table} ${required.map((c) => `ALTER COLUMN ${c.col} SET NOT NULL`).join(", ")};` : ""}
      ${
        renamed
          ? `IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = 'tenant_id' AND NOT attisdropped)
        THEN CREATE UNIQUE INDEX IF NOT EXISTS ${keyIndex} ON ${table} (tenant_id, ${keyCol});
        ELSE CREATE UNIQUE INDEX IF NOT EXISTS ${keyIndex} ON ${table} (${keyCol}); END IF;`
          : ""
      }
    END $expand$`;
  const sync = `CREATE OR REPLACE FUNCTION ${table}_sync() RETURNS trigger LANGUAGE plpgsql AS $sync$ BEGIN
      IF TG_OP = 'INSERT' AND NEW.json IS NOT NULL OR TG_OP = 'UPDATE' AND NEW.json IS DISTINCT FROM OLD.json THEN
        ${cols.map((c) => `NEW.${c.col} := ${fromJson("NEW.json", c.field, c.type)};`).join("\n        ")}
        ${renamed ? `NEW.${keyCol} := NEW.id;` : ""}
      ELSE
        ${renamed ? `NEW.id := NEW.${keyCol};` : ""}
        NEW.json := (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
          FROM jsonb_each(jsonb_build_object(${fields("NEW.", "NEW.id").join(", ")})) AS e(k, v)
          WHERE jsonb_typeof(v) <> 'null');
      END IF;
      RETURN NEW;
    END $sync$`;
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
    expand,
    sync,
    `DROP TRIGGER IF EXISTS ${table}_sync ON ${table}`,
    `CREATE TRIGGER ${table}_sync BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${table}_sync()`,
    `DO $bump$ BEGIN IF to_regclass('durable_map_versions') IS NOT NULL THEN
      CREATE OR REPLACE FUNCTION qm_durable_map_bump() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN
        UPDATE durable_map_versions SET v = v + 1 WHERE tbl = TG_ARGV[0];
        RETURN NULL;
      END $fn$;
      DROP TRIGGER IF EXISTS ${table}_bump ON ${table};
      CREATE TRIGGER ${table}_bump AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH STATEMENT EXECUTE FUNCTION qm_durable_map_bump('${table}');
    END IF; END $bump$`,
    ...(opts.statements ?? []),
  ];
  const column = (name: string) =>
    `EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = '${name}' AND NOT attisdropped)`;
  const contract = {
    id: `contract/${id}`,
    statements: [
      "SET LOCAL lock_timeout = '3s'",
      `DO $contract$ BEGIN
        IF to_regclass('${table}') IS NULL THEN RETURN; END IF;
        IF ${column("json")} AND NOT ${column(all[0]!.col.slice(1, -1))} THEN
          RAISE EXCEPTION '${table}: contract before expand';
        END IF;
        DROP TRIGGER IF EXISTS ${table}_sync ON ${table};
        DROP TRIGGER IF EXISTS ${table}_bump ON ${table};
        DROP FUNCTION IF EXISTS ${table}_sync();
        ALTER TABLE ${table} DROP COLUMN IF EXISTS json;
        ${
          renamed
            ? `IF ${column("id")} THEN
          ALTER TABLE ${table} DROP COLUMN id;
          ALTER TABLE ${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY USING INDEX ${keyIndex};
        END IF;`
            : ""
        }
      END $contract$`,
    ],
  };
  const conversion = { id, statements, spec, dropKeys: opts.dropKeys ?? [], contract };
  conversions.set(id, conversion);
  return conversion;
}

function toParam(value: unknown, type: ColumnType): unknown {
  if (value === undefined || value === null) return null;
  if (type === "jsonb") return jsonbStringify(value);
  if (type === "text") return pgTextSafe(String(value));
  if (type === "text[]") return (value as string[]).map(pgTextSafe);
  return value;
}

export function tableCodec<T>(spec: TableSpec) {
  const fields = [spec.key, ...Object.keys(spec.columns)];
  const types: Record<string, ColumnType> = { [spec.key]: "text" };
  for (const [field, c] of Object.entries(spec.columns)) types[field] = c.type;
  const names = fields.map(columnName);
  const row = (r: Record<string, unknown>): T => {
    const out: Record<string, unknown> = {};
    for (const f of spec.keyIsField ? fields : fields.slice(1)) {
      const v = r[columnName(f).slice(1, -1)];
      if (v != null) out[f] = types[f] === "bigint" ? Number(v) : v;
    }
    return out as T;
  };
  return {
    columns: names.join(", "),
    placeholders: names.map((_, i) => `$${i + 1}`).join(", "),
    updates: names
      .slice(1)
      .map((n) => `${n} = EXCLUDED.${n}`)
      .join(", "),
    values: (key: string, record: T): unknown[] => [
      key,
      ...fields.slice(1).map((f) => toParam((record as Record<string, unknown>)[f], types[f]!)),
    ],
    row,
    rows: (rows: Rows): T[] => rows.map(row),
  };
}

export function typedTable<T>(db: Pick<PgPool, "q" | "pool">, spec: TableSpec) {
  const codec = tableCodec<T>(spec);
  const key = columnName(spec.key);
  const select = `SELECT ${codec.columns} FROM ${spec.table}`;
  const insert = `INSERT INTO ${spec.table} (${codec.columns}) VALUES (${codec.placeholders})`;
  const conflict = () => `ON CONFLICT (${tenantCols(key)})`;
  const upsert = () => `${insert} ${conflict()} DO UPDATE SET ${codec.updates}`;
  const one = (rows: Rows) => (rows[0] ? codec.row(rows[0]) : null);
  const modify = async (id: string, fn: (current: T | null) => T | null): Promise<T | null> =>
    withPgTransaction(await db.pool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenantLockKey(`${spec.table}:${id}`)]);
      const current = one((await client.query(`${select} WHERE ${key} = $1 FOR UPDATE`, [id])).rows);
      const next = fn(current);
      if (next === current) return current;
      if (next) await client.query(upsert(), codec.values(id, next));
      else await client.query(`DELETE FROM ${spec.table} WHERE ${key} = $1`, [id]);
      return next;
    });
  return {
    codec,
    get: async (id: string) => one(await db.q(`${select} WHERE ${key} = $1`, [id])),
    all: async () => codec.rows(await db.q(`${select} ORDER BY ${key}`)),
    where: async (field: Extract<keyof T, string>, value: unknown) =>
      codec.rows(await db.q(`${select} WHERE ${columnName(field)} = $1 ORDER BY ${key}`, [value])),
    async put(id: string, record: T): Promise<void> {
      await db.q(upsert(), codec.values(id, record));
    },
    insert: async (id: string, record: T) =>
      (await db.q(`${insert} ${conflict()} DO NOTHING RETURNING 1 AS ok`, codec.values(id, record))).length > 0,
    insertOrGet: async (id: string, record: T) =>
      codec.row(
        (
          await db.q(`${insert} ${conflict()} DO UPDATE SET ${key} = EXCLUDED.${key} RETURNING ${codec.columns}`, [
            ...codec.values(id, record),
          ])
        )[0]!,
      ),
    delete: async (id: string) =>
      (await db.q(`DELETE FROM ${spec.table} WHERE ${key} = $1 RETURNING 1 AS ok`, [id])).length > 0,
    take: async (id: string) =>
      one(await db.q(`DELETE FROM ${spec.table} WHERE ${key} = $1 RETURNING ${codec.columns}`, [id])),
    modify,
    update: (id: string, fn: (current: T) => T) => modify(id, (current) => current && fn(current)),
  };
}

export type TypedTable<T> = ReturnType<typeof typedTable<T>>;

export function retireJsonKeysMigration(
  id: string,
  table: string,
  opts: { columns?: Readonly<Record<string, ColumnSpec>>; drop?: readonly string[] },
): PgMigrationDefinition {
  const moved = Object.entries(opts.columns ?? {});
  const list = `ARRAY[${[...moved.map(([field]) => field), ...(opts.drop ?? [])].map((k) => `'${k}'`).join(", ")}]::text[]`;
  const sets = [
    ...moved.map(
      ([field, c]) => `${columnName(field)} = COALESCE(${fromJson("json", field, c.type)}, ${columnName(field)})`,
    ),
    `json = json - ${list}`,
  ];
  return {
    id,
    statements: [
      `DO $retire$ BEGIN
        IF to_regclass('${table}') IS NULL THEN RETURN; END IF;
        ${moved.length ? `ALTER TABLE ${table} ${moved.map(([field, c]) => `ADD COLUMN IF NOT EXISTS ${columnName(field)} ${c.type}`).join(", ")};` : ""}
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = '${table}'::regclass AND attname = 'json' AND NOT attisdropped) THEN
          UPDATE ${table} SET ${sets.join(", ")} WHERE json ?| ${list};
        END IF;
      END $retire$`,
    ],
  };
}

export function ownerIndexMigration(table: string): PgMigrationDefinition {
  return {
    id: `triggers/${table}/0002-owner-index`,
    statements: [`CREATE INDEX IF NOT EXISTS ${table}_owner_scope_id ON ${table} (owner_scope_id)`],
  };
}
