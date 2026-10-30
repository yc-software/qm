import { createPgPool, withPgTransaction, type PgMigrationDefinition, type Rows } from "./pg-pool.ts";
import { keyValueConversion } from "./kv-conversion.ts";
import { TENANT } from "../tenants/migrations.ts";
import { jsonbSafeStringify, pgTextSafe } from "../util/text.ts";

export type ColumnType = "text" | "bigint" | "double precision" | "boolean" | "jsonb" | "text[]";

export type Columns<T, K extends string = never> = {
  readonly [F in Exclude<Extract<keyof T, string>, K>]-?: ColumnType;
};

export interface TableSpec<T = Record<string, unknown>, K extends string = never> {
  table: string;
  key?: string;
  fieldKey?: K;
  global?: boolean;
  required?: readonly Extract<keyof T, string>[];
  preserve?: readonly Extract<keyof T, string>[];
  columns: Columns<T, K>;
}

const keyOf = (spec: TableSpec<never, string>): string => columnName(spec.fieldKey ?? spec.key ?? "id");

export const columnName = (field: string): string => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

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

export function tableConversion<T, K extends string>(
  spec: TableSpec<T, K>,
  opts: { indexes?: readonly string[]; constraints?: readonly string[] } = {},
): PgMigrationDefinition {
  const key = keyOf(spec as TableSpec<never, string>);
  const required = new Set<string>(spec.required ?? []);
  const fields = Object.entries(spec.columns) as Array<[string, ColumnType]>;
  return keyValueConversion({
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
    ...opts,
  });
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
  const db = createPgPool(databaseUrl, [...before, migration]);
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
    row,
    select,
    scoped,
    get: async (id: string) => one(await db.q(`${select} WHERE ${scoped(`${key} = $1`)}`, [id])),
    entries: async (): Promise<Array<[string, T]>> =>
      (await db.q(`${select}${spec.global ? "" : ` WHERE tenant_id = ${TENANT}`} ORDER BY ${key}`)).map((r) => [
        String(r[key]),
        row(r),
      ]),
    where: async (field: Extract<keyof T, string>, value: unknown) =>
      (await db.q(`${select} WHERE ${scoped(`${columnName(field)} = $1`)} ORDER BY ${key}`, [value])).map(row),
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
    take: async (id: string) =>
      one(
        await db.q(`DELETE FROM ${spec.table} WHERE ${scoped(`${key} = $1`)} RETURNING ${[key, ...cols].join(", ")}`, [
          id,
        ]),
      ),
  };
}

export type TypedTable<T extends object> = ReturnType<typeof typedTable<T, string>>;
