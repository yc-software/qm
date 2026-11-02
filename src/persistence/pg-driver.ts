import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import type postgres from "postgres";
import type { Options, PostgresType, Sql, TransactionSql } from "postgres";

export type { Sql };

type Queryable = Sql | TransactionSql;

export interface PgResult<R> {
  rows: R[];
  rowCount: number;
}

export interface PgClient {
  query<R = any>(text: string, params?: readonly unknown[]): Promise<PgResult<R>>;
}

export interface PgConnection {
  url: string;
  ssl: boolean | Record<string, unknown>;
}

const CONNECT_TIMEOUT_S = 10;

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

function tlsFiles(params: URLSearchParams, names: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(names).flatMap(([key, param]) => {
      const file = params.get(param);
      return file ? [[key, readFileSync(file, "utf8")]] : [];
    }),
  );
}

function sslOption(params: URLSearchParams, ca: string | undefined): PgConnection["ssl"] {
  if (ca) return { ...tlsFiles(params, { cert: "sslcert", key: "sslkey" }), ca };
  const mode = params.get("sslmode");
  if (mode === "disable") return false;
  if (mode || ["sslcert", "sslkey", "sslrootcert"].some((name) => params.has(name))) {
    const files = tlsFiles(params, { cert: "sslcert", key: "sslkey", ca: "sslrootcert" });
    return mode === "no-verify" ? { ...files, rejectUnauthorized: false } : files;
  }
  const flag = params.get("ssl");
  if (flag === "true" || flag === "1") return true;
  if (flag === "no-verify") return { rejectUnauthorized: false };
  return flag === null && params.get("sslnegotiation") === "direct";
}

export function pgConnectionOptions(connectionString: string, ca?: string): PgConnection {
  const url = new URL(connectionString);
  const ssl = sslOption(url.searchParams, ca);
  for (const name of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(name);
  return { url: url.toString(), ssl };
}

interface IdleState {
  busy: number;
  sockets: Set<Socket>;
}

interface SocketTarget {
  host: string[];
  port: number[];
  path: string | false;
}

const idleStates = new WeakMap<object, IdleState>();

function openSocket(target: SocketTarget, state: IdleState): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = target.path ? connect(target.path) : connect(target.port[0]!, target.host[0]!);
    socket.setTimeout(CONNECT_TIMEOUT_S * 1000, () => socket.destroy(new Error("Postgres connection timeout")));
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.off("error", reject);
      Object.assign(socket, { host: target.host[0], port: target.port[0] });
      state.sockets.add(socket);
      socket.once("close", () => state.sockets.delete(socket));
      if (state.busy === 0) socket.unref();
      resolve(socket);
    });
  });
}

export interface PgSqlOptions {
  max: number;
  ca?: string;
  prepare?: boolean;
  pinned?: boolean;
  onclose?: () => void;
}

export function openPgSql(
  connectionString: string,
  { max, ca, prepare = true, pinned = false, onclose }: PgSqlOptions,
): Sql {
  const { url, ssl } = pgConnectionOptions(connectionString, ca);
  const state: IdleState = { busy: pinned ? 1 : 0, sockets: new Set() };
  const options = {
    max,
    ssl,
    prepare,
    connect_timeout: CONNECT_TIMEOUT_S,
    max_lifetime: null,
    onnotice: () => {},
    transform: { undefined: null },
    types: PG_TYPES,
    socket: (target: SocketTarget) => openSocket(target, state),
    ...(onclose ? { onclose } : {}),
  };
  const open = createRequire(import.meta.url)("postgres") as typeof postgres;
  const sql = open(url, options as Options<Record<string, PostgresType>>) as unknown as Sql;
  idleStates.set(sql, state);
  return sql;
}

function holdPg(sql: Sql): () => void {
  const state = idleStates.get(sql);
  if (!state) return () => {};
  if (state.busy++ === 0) for (const socket of state.sockets) socket.ref();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--state.busy === 0) for (const socket of state.sockets) socket.unref();
  };
}

export async function usePg<T>(sql: Sql, work: () => Promise<T>): Promise<T> {
  const release = holdPg(sql);
  try {
    return await work();
  } finally {
    release();
  }
}

export async function reservePg(sql: Sql): Promise<PgClient & { release(): void }> {
  const release = holdPg(sql);
  try {
    const reserved = await sql.reserve();
    return {
      ...pgClient(reserved),
      release: () => {
        reserved.release();
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

export function pgUnsafe(sql: Queryable, text: string, params: readonly unknown[] = []) {
  const bound = params.map((value) => (value === undefined || value === null ? null : sql.typed(value as never, 0)));
  return sql.unsafe(text, bound as never[], { prepare: true });
}

export async function pgRun<R>(sql: Queryable, text: string, params: readonly unknown[] = []): Promise<PgResult<R>> {
  const result = await pgUnsafe(sql, text, params);
  return { rows: [...result] as R[], rowCount: result.count ?? 0 };
}

export function pgClient(sql: Queryable): PgClient {
  return { query: (text, params) => pgRun(sql, text, params) };
}
