import { createPgPool, withPgTransaction, type PgMigrationDefinition, type Rows } from "./pg-pool.ts";
import { typedTableMigration } from "./typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { jsonbSafeStringify, pgTextSafe } from "../util/text.ts";
import { tenantMap } from "../tenants/context.ts";

export type ColumnType = "text" | "bigint" | "double precision" | "boolean" | "jsonb" | "text[]";

type Columns<T, K extends string = never> = {
  readonly [F in Exclude<Extract<keyof T, string>, K>]-?: ColumnType;
};

export interface TableSpec<T = Record<string, unknown>, K extends string = never> {
  table: string;
  key?: string;
  fieldKey?: K;
  global?: boolean;
  required?: readonly Extract<keyof T, string>[];
  preserve?: readonly Extract<keyof T, string>[];
  indexes?: readonly string[];
  columns: Columns<T, K>;
}

const keyOf = (spec: TableSpec<never, string>): string => columnName(spec.fieldKey ?? spec.key ?? "id");

const columnName = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function fromJson(field: string, type: ColumnType): string {
  const value = `json->'${field}'`;
  const when = (kind: string, expr: string) => `CASE WHEN jsonb_typeof(${value}) = '${kind}' THEN ${expr} END`;
  switch (type) {
    case "text":
      return when("string", `json->>'${field}'`);
    case "bigint":
      return when("number", `(json->>'${field}')::numeric::bigint`);
    case "double precision":
      return when("number", `(json->>'${field}')::float8`);
    case "boolean":
      return when("boolean", `(${value})::boolean`);
    case "jsonb":
      return `CASE WHEN jsonb_typeof(${value}) <> 'null' THEN ${value} END`;
    case "text[]":
      return when("array", `ARRAY(SELECT jsonb_array_elements_text(${value}))`);
  }
}

export function tableConversion<T, K extends string>(spec: TableSpec<T, K>): PgMigrationDefinition {
  const key = keyOf(spec as TableSpec<never, string>);
  const required = new Set<string>(spec.required ?? []);
  const fields = Object.entries(spec.columns) as Array<[string, ColumnType]>;
  return typedTableMigration({
    table: spec.table,
    columns: [
      `${key} TEXT NOT NULL`,
      ...fields.map(
        ([field, type]) => `${columnName(field)} ${type.toUpperCase()}${required.has(field) ? " NOT NULL" : ""}`,
      ),
    ],
    primaryKey: [key],
    backfill: Object.fromEntries([
      [key, "id"],
      ...fields.map(([field, type]) => [columnName(field), fromJson(field, type)]),
    ]),
    ...(spec.indexes ? { indexes: spec.indexes } : {}),
  });
}

export function globalConversion<T, K extends string>(
  spec: TableSpec<T, K>,
  backfill: Readonly<Record<string, string>> = {},
): PgMigrationDefinition {
  const { table } = spec;
  const key = keyOf(spec as TableSpec<never, string>);
  const required = new Set<string>(spec.required ?? []);
  const fields = Object.entries(spec.columns) as Array<[string, ColumnType]>;
  const columns = fields.map(([field]) => columnName(field));
  return {
    id: `tenancy/${table}/0001-typed`,
    statements: [
      `SET LOCAL lock_timeout = '5s'`,
      `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
      `ALTER TABLE ${table} RENAME TO ${table}_kv`,
      `ALTER INDEX ${table}_pkey RENAME TO ${table}_kv_pkey`,
      `CREATE TABLE ${table}(${[
        `${key} TEXT PRIMARY KEY`,
        ...fields.map(
          ([field, type]) => `${columnName(field)} ${type.toUpperCase()}${required.has(field) ? " NOT NULL" : ""}`,
        ),
      ].join(", ")})`,
      `INSERT INTO ${table}(${[key, ...columns].join(", ")})
         SELECT ${["id", ...fields.map(([field, type]) => backfill[field] ?? fromJson(field, type))].join(", ")} FROM ${table}_kv`,
      `DROP TABLE ${table}_kv`,
      `DO $drop_version$ BEGIN
         IF to_regclass('durable_map_versions') IS NOT NULL THEN
           DELETE FROM durable_map_versions WHERE tbl = '${table}';
         END IF;
       END $drop_version$`,
    ],
  };
}

function toParam(value: unknown, type: ColumnType): unknown {
  if (value === undefined || value === null) return null;
  if (type === "jsonb") return jsonbSafeStringify(value);
  if (type === "text") return pgTextSafe(String(value));
  if (type === "text[]") return (value as string[]).map(pgTextSafe);
  return value;
}

export function typedTable<T extends object, K extends string = never>(
  databaseUrl: string,
  spec: TableSpec<T, K>,
  migration: PgMigrationDefinition,
  before: readonly PgMigrationDefinition[] = [],
) {
  const db = createPgPool(databaseUrl, [TENANCY_BASE, ...before, migration]);
  const key = keyOf(spec as TableSpec<never, string>);
  const types = spec.columns as Readonly<Record<string, ColumnType>>;
  const fields = Object.keys(types);
  const preserved = new Set<string>(spec.preserve ?? []);
  const written = fields.filter((field) => !preserved.has(field));
  const cols = fields.map(columnName);
  const scoped = (where: string) => (spec.global ? where : `tenant_id = ${TENANT} AND ${where}`);
  const select = `SELECT ${[key, ...cols].join(", ")} FROM ${spec.table}`;
  const row = (r: Record<string, unknown>): T => {
    const out: Record<string, unknown> = spec.fieldKey ? { [spec.fieldKey]: r[key] } : {};
    fields.forEach((field, i) => {
      const value = r[cols[i]!];
      if (value != null) out[field] = types[field] === "bigint" ? Number(value) : value;
    });
    return out as T;
  };
  const one = (rows: Rows): T | null => (rows[0] ? row(rows[0]) : null);
  const values = (id: string, record: Partial<T>, picked: readonly string[]) => [
    id,
    ...picked.map((field) => toParam((record as Record<string, unknown>)[field], types[field]!)),
  ];
  const insert = (picked: readonly string[]) =>
    `INSERT INTO ${spec.table} (${[key, ...picked.map(columnName)].join(", ")})
     VALUES (${[key, ...picked].map((_, i) => `$${i + 1}`).join(", ")})
     ON CONFLICT (${spec.global ? key : `tenant_id, ${key}`})`;
  const assign = (picked: readonly string[]) => picked.map((f) => `${columnName(f)} = EXCLUDED.${columnName(f)}`);
  const put = (id: string, record: T) =>
    db.q(
      `${insert(fields)} DO UPDATE SET ${[`${key} = EXCLUDED.${key}`, ...assign(fields)].join(", ")}`,
      values(id, record, fields),
    );
  return {
    db,
    close: () => db.close(),
    row,
    select,
    scoped,
    get: async (id: string) => one(await db.q(`${select} WHERE ${scoped(`${key} = $1`)}`, [id])),
    entries: async (): Promise<Array<[string, T]>> =>
      (await db.q(`${select}${spec.global ? "" : ` WHERE tenant_id = ${TENANT}`} ORDER BY ${key}`)).map((r) => [
        String(r[key]),
        row(r),
      ]),
    where: async (field: Extract<keyof T, string>, value: unknown): Promise<Array<[string, T]>> =>
      (await db.q(`${select} WHERE ${scoped(`${columnName(field)} = $1`)} ORDER BY ${key}`, [value])).map((r) => [
        String(r[key]),
        row(r),
      ]),
    async put(id: string, record: T): Promise<void> {
      await put(id, record);
    },
    putIfAbsent: async (id: string, record: T): Promise<T> =>
      row(
        (
          await db.q(
            `${insert(fields)} DO UPDATE SET ${key} = EXCLUDED.${key} RETURNING ${[key, ...cols].join(", ")}`,
            values(id, record, fields),
          )
        )[0]!,
      ),
    async merge(id: string, patch: Partial<T>): Promise<T | null> {
      const picked = Object.keys(patch).filter((field) => Object.hasOwn(types, field));
      if (!picked.length) return one(await db.q(`${select} WHERE ${scoped(`${key} = $1`)}`, [id]));
      const set = picked.map((field, i) => `${columnName(field)} = $${i + 2}`).join(", ");
      return one(
        await db.q(
          `UPDATE ${spec.table} SET ${set} WHERE ${scoped(`${key} = $1`)} RETURNING ${[key, ...cols].join(", ")}`,
          values(id, patch, picked),
        ),
      );
    },
    update: async (id: string, fn: (current: T) => T): Promise<T | null> =>
      withPgTransaction(await db.pool(), async (client) => {
        const current = one((await client.query(`${select} WHERE ${scoped(`${key} = $1`)} FOR UPDATE`, [id])).rows);
        if (!current) return null;
        const next = fn(current);
        if (next !== current)
          await client.query(
            `UPDATE ${spec.table} SET ${written.map((f, i) => `${columnName(f)} = $${i + 2}`).join(", ")} WHERE ${scoped(`${key} = $1`)}`,
            values(id, next, written),
          );
        return next;
      }),
    async delete(id: string): Promise<void> {
      await db.q(`DELETE FROM ${spec.table} WHERE ${scoped(`${key} = $1`)}`, [id]);
    },
    async deleteWhere(id: string, field: Extract<keyof T, string>, value: unknown): Promise<void> {
      await db.q(`DELETE FROM ${spec.table} WHERE ${scoped(`${key} = $1 AND ${columnName(field)} = $2`)}`, [id, value]);
    },
    take: async (id: string) =>
      one(
        await db.q(`DELETE FROM ${spec.table} WHERE ${scoped(`${key} = $1`)} RETURNING ${[key, ...cols].join(", ")}`, [
          id,
        ]),
      ),
  };
}

type TypedTable<T extends object> = ReturnType<typeof typedTable<T, string>>;

export type KeyedRows<T extends object> = Pick<
  TypedTable<T>,
  "get" | "entries" | "where" | "put" | "putIfAbsent" | "merge" | "update" | "delete" | "deleteWhere" | "take"
>;

export function memoryRows<T extends object>(global = false): KeyedRows<T> {
  const shared = new Map<string, T>();
  const rows = global ? () => shared : tenantMap<T>();
  const copy = (value: T | undefined): T | null => (value === undefined ? null : structuredClone(value));
  return {
    get: async (id) => copy(rows().get(id)),
    entries: async () =>
      [...rows().entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => [id, structuredClone(value)]),
    where: async (field, value) =>
      [...rows().entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([, row]) => row[field] === value)
        .map(([id, row]) => [id, structuredClone(row)]),
    async put(id, record) {
      rows().set(id, structuredClone(record));
    },
    async putIfAbsent(id, record) {
      if (!rows().has(id)) rows().set(id, structuredClone(record));
      return copy(rows().get(id))!;
    },
    async merge(id, patch) {
      const current = rows().get(id);
      if (!current) return null;
      for (const [field, value] of Object.entries(patch))
        if (value === undefined) delete (current as Record<string, unknown>)[field];
        else (current as Record<string, unknown>)[field] = structuredClone(value);
      return copy(current);
    },
    async update(id, fn) {
      const current = rows().get(id);
      if (!current) return null;
      const next = fn(structuredClone(current));
      rows().set(id, structuredClone(next));
      return next;
    },
    async delete(id) {
      rows().delete(id);
    },
    async deleteWhere(id, field, value) {
      if (rows().get(id)?.[field] === value) rows().delete(id);
    },
    async take(id) {
      const current = copy(rows().get(id));
      rows().delete(id);
      return current;
    },
  };
}

export function keyedRows<T extends object, K extends string = never>(
  databaseUrl: string | undefined,
  spec: TableSpec<T, K>,
): KeyedRows<T> {
  if (!databaseUrl) return memoryRows<T>(spec.global);
  return typedTable(databaseUrl, spec, spec.global ? globalConversion(spec) : tableConversion(spec));
}
