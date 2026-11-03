import { createRequire } from "node:module";
import type postgres from "postgres";
import type { Options, PostgresType, Sql, TransactionSql } from "postgres";

export type { Sql };

type Queryable = Sql | TransactionSql;

interface PgResult<R> {
  rows: R[];
  rowCount: number;
}

export interface PgClient {
  query<R = any>(text: string, params?: readonly unknown[]): Promise<PgResult<R>>;
}

export interface PgConnection {
  url: string;
  ssl?: { ca: string };
}

export const CONNECT_TIMEOUT_S = 10;
const IDLE_TIMEOUT_S = 10;

function pgText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

const PG_TEXT_TYPES = [16, 17, 25, 114, 705, 1043, 1082, 1114, 1184, 3802];

const PG_TYPES = Object.fromEntries(
  PG_TEXT_TYPES.map((oid) => [`pg${oid}`, { to: oid, from: [], serialize: pgText, parse: (x: string) => x }]),
) as Record<string, PostgresType>;

export function pgConnectionOptions(connectionString: string, ca?: string): PgConnection {
  const url = new URL(connectionString);
  if (ca) {
    for (const name of ["ssl", "sslmode", "sslrootcert"]) url.searchParams.delete(name);
    return { url: url.toString(), ssl: { ca } };
  }
  if (url.searchParams.get("sslmode") === "no-verify") url.searchParams.set("sslmode", "require");
  return { url: url.toString() };
}

export interface PgSqlOptions {
  max: number;
  ca?: string;
  connectTimeoutS?: number;
  statementTimeoutMs?: number;
  onclose?: (id: number) => void;
}

export function openPgSql(
  connectionString: string,
  { max, ca, connectTimeoutS = CONNECT_TIMEOUT_S, statementTimeoutMs, onclose }: PgSqlOptions,
): Sql {
  const { url, ssl } = pgConnectionOptions(connectionString, ca);
  const options = {
    max,
    prepare: true,
    connect_timeout: connectTimeoutS,
    idle_timeout: IDLE_TIMEOUT_S,
    max_lifetime: null,
    onnotice: () => {},
    transform: { undefined: null },
    types: PG_TYPES,
    ...(ssl ? { ssl } : {}),
    ...(statementTimeoutMs ? { connection: { statement_timeout: statementTimeoutMs } } : {}),
    ...(onclose ? { onclose } : {}),
  };
  const open = createRequire(import.meta.url)("postgres") as typeof postgres;
  return open(url, options as Options<Record<string, PostgresType>>) as unknown as Sql;
}

export async function reservePg(sql: Sql): Promise<PgClient & { release(): void }> {
  const reserved = await sql.reserve();
  return { ...pgClient(reserved), release: () => reserved.release() };
}

export function pgUnsafe(sql: Queryable, text: string, params: readonly unknown[] = []) {
  const bound = params.map((value) => (value === undefined || value === null ? null : sql.typed(value as never, 0)));
  return sql.unsafe(text, bound as never[], { prepare: true });
}

async function pgRun<R>(sql: Queryable, text: string, params: readonly unknown[] = []): Promise<PgResult<R>> {
  const result = await pgUnsafe(sql, text, params);
  return { rows: [...result] as R[], rowCount: result.count ?? 0 };
}

export function pgClient(sql: Queryable): PgClient {
  return { query: (text, params) => pgRun(sql, text, params) };
}
