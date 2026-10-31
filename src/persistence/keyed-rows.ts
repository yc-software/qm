import { createPgPool, withPgTransaction, type PgMigrationDefinition, type Rows } from "./pg-pool.ts";
import { typedColumns, type ColumnCast, type TypedColumns } from "./typed-columns.ts";
import { upsertStatement } from "./typed-statements.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";

export type RowColumns<T, K extends string> = {
  readonly [F in keyof (T & Record<K, string>) & string]-?: ColumnCast;
};

export interface RowTable<T, K extends string> {
  table: string;
  key: K;
  columns: RowColumns<T, K>;
  migrations: readonly PgMigrationDefinition[];
  recordKey?: boolean;
  global?: boolean;
}

export interface KeyedRows<T> {
  get(id: string): Promise<T | null>;
  entries(): Promise<Array<[string, T]>>;
  put(id: string, record: T): Promise<void>;
  putIfAbsent(id: string, record: T): Promise<T>;
  merge(id: string, patch: Partial<T>): Promise<T | null>;
  update(id: string, fn: (current: T) => T): Promise<T | null>;
  delete(id: string): Promise<void>;
}

type Fields = Record<string, unknown>;

function pick(casts: Readonly<Record<string, ColumnCast>>, fields: readonly string[]): TypedColumns<Fields> {
  return typedColumns<Fields>(Object.fromEntries(fields.map((field) => [field, casts[field]!])));
}

export function pgRows<T, K extends string>(databaseUrl: string, spec: RowTable<T, K>) {
  const db = createPgPool(databaseUrl, [TENANCY_BASE, ...spec.migrations]);
  const casts = spec.columns as Readonly<Record<string, ColumnCast>>;
  const all = typedColumns<Fields>(casts);
  const key = pick(casts, [spec.key]).names;
  const rest = Object.keys(casts).filter((field) => field !== spec.key);
  const restColumns = pick(casts, rest);
  const scoped = (where: string) => (spec.global ? where : `tenant_id = ${TENANT} AND ${where}`);
  const select = `SELECT ${all.names} FROM ${spec.table}`;
  const insert = `INSERT INTO ${spec.table}(${all.names}) VALUES (${all.placeholders}) ON CONFLICT (${key})`;
  const assign = restColumns.names
    .split(", ")
    .map((name) => `${name} = EXCLUDED.${name}`)
    .join(", ");
  const put = spec.global ? `${insert} DO UPDATE SET ${assign}` : upsertStatement(spec.table, all, key);
  const putIfAbsent = spec.global ? `${insert} DO NOTHING` : upsertStatement(spec.table, all, key, "nothing");
  const row = (r: Fields): T => {
    const out = all.fromRow(r);
    if (!spec.recordKey) delete out[spec.key];
    return out as T;
  };
  const one = (rows: Rows): T | null => (rows[0] ? row(rows[0]) : null);
  const params = (id: string, record: T) => all.params({ ...(record as Fields), [spec.key]: id });
  const get = async (id: string) => one(await db.q(`${select} WHERE ${scoped(`${key} = $1`)}`, [id]));
  return {
    db,
    close: () => db.close(),
    select,
    scoped,
    row,
    get,
    entries: async (): Promise<Array<[string, T]>> =>
      (await db.q(`${select}${spec.global ? "" : ` WHERE tenant_id = ${TENANT}`} ORDER BY ${key}`)).map((r) => [
        String(r[key]),
        row(r),
      ]),
    async put(id: string, record: T): Promise<void> {
      await db.q(put, params(id, record));
    },
    async putIfAbsent(id: string, record: T): Promise<T> {
      await db.q(putIfAbsent, params(id, record));
      return (await get(id)) ?? record;
    },
    async merge(id: string, patch: Partial<T>): Promise<T | null> {
      const fields = Object.keys(patch).filter((field) => field !== spec.key && Object.hasOwn(casts, field));
      if (!fields.length) return get(id);
      const set = pick(casts, fields);
      return one(
        await db.q(
          `UPDATE ${spec.table} SET (${set.names}) = ROW(${set.placeholders})
           WHERE ${scoped(`${key} = $${fields.length + 1}`)} RETURNING ${all.names}`,
          [...set.params(patch as Fields), id],
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
            `UPDATE ${spec.table} SET (${restColumns.names}) = ROW(${restColumns.placeholders})
             WHERE ${scoped(`${key} = $${rest.length + 1}`)}`,
            [...restColumns.params(next as Fields), id],
          );
        return next;
      }),
    async delete(id: string): Promise<void> {
      await db.q(`DELETE FROM ${spec.table} WHERE ${scoped(`${key} = $1`)}`, [id]);
    },
  };
}
