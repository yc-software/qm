import type { Pool, PoolClient, QueryConfig } from "pg";
import { swallowAs } from "../util/errors.ts";

export type { Pool, PoolClient };

export type Rows = Record<string, unknown>[];

export interface PgPool {
  pool(): Promise<Pool>;
  q(text: string, params?: unknown[]): Promise<Rows>;
  query(text: string, params?: unknown[], timeoutMs?: number): Promise<{ rows: Rows; rowCount: number }>;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  schema?(schemaSql: string): Promise<void>;
  close(): Promise<void>;
}

const CONNECTION_ERROR_CODES = new Set(["57P01", "57P02", "57P03"]);
const RETIRED_POOL_POLL_MS = 50;

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (code.startsWith("08") || CONNECTION_ERROR_CODES.has(code)) return true;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /connection terminated|closed the connection|econnreset|econnrefused|epipe|etimedout/i.test(message);
}

export async function withPgTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  onFailure?: (error: unknown) => void,
): Promise<T> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        onFailure?.(rollbackError);
      }
    }
    onFailure?.(error);
    throw error;
  } finally {
    client?.release();
  }
}

export function assertOneStatement(stmt: string): void {
  const bare = stmt
    .replace(/--[^\n]*/g, "")
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "")
    .replace(/'(?:[^']|'')*'/g, "")
    .replace(/;\s*$/, "");
  if (bare.includes(";")) {
    throw new Error(`pg-pool: each schema element must be a single statement (found ';' in: ${stmt.slice(0, 80)}…)`);
  }
}

async function applyDdl(pool: Pool, statements: string[]): Promise<void> {
  const ddl = await pool.connect();
  try {
    await ddl.query("SELECT pg_advisory_lock(hashtext('agent-platform:schema-init'))");
    for (const stmt of statements) {
      await ddl.query(stmt);
    }
  } finally {
    await ddl
      .query("SELECT pg_advisory_unlock(hashtext('agent-platform:schema-init'))")
      .catch(swallowAs("pg-pool: schema-init unlock", undefined));
    ddl.release();
  }
}

export function createPgPool(connectionString: string, statements: string[]): PgPool {
  const schema = statements.map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of schema) assertOneStatement(stmt);
  let poolP: Promise<Pool> | null = null;
  let closed = false;
  const retiredPools = new Set<Pool>();
  const closingPools = new Map<Pool, Promise<void>>();
  function endPool(target: Pool): Promise<void> {
    const existing = closingPools.get(target);
    if (existing) return existing;
    const closing = target.end().finally(() => {
      retiredPools.delete(target);
      closingPools.delete(target);
    });
    closingPools.set(target, closing);
    return closing;
  }
  function closeWhenDrained(target: Pool): void {
    if (!retiredPools.has(target)) return;
    if (target.waitingCount > 0) {
      const timer = setTimeout(() => closeWhenDrained(target), RETIRED_POOL_POLL_MS);
      timer.unref();
      return;
    }
    void endPool(target).catch(swallowAs("pg-pool: close retired pool", undefined));
  }
  function retirePool(failed: Pool): void {
    const active = poolP;
    if (!active) return;
    void active.then(
      (current) => {
        if (current !== failed || poolP !== active) return;
        poolP = null;
        retiredPools.add(failed);
        closeWhenDrained(failed);
      },
      () => undefined,
    );
  }
  function pool(): Promise<Pool> {
    if (closed) return Promise.reject(new Error("pg-pool: closed"));
    if (!poolP) {
      poolP = (async () => {
        const pg = (await import("pg")).default;
        const p = new pg.Pool({ connectionString });
        p.on("error", (err) => {
          console.error("[pg] idle client error; retiring pool:", err);
          retirePool(p);
        });
        try {
          await applyDdl(p, schema);
        } catch (e) {
          await p.end().catch(swallowAs("pg-pool: close after schema failure", undefined));
          throw e;
        }
        return p;
      })().catch((e) => {
        poolP = null;
        throw e;
      });
    }
    return poolP;
  }
  async function query(
    text: string,
    params: unknown[] = [],
    timeoutMs?: number,
  ): Promise<{ rows: Rows; rowCount: number }> {
    const current = await pool();
    try {
      const res = timeoutMs
        ? await current.query({ text, values: params, query_timeout: timeoutMs } as QueryConfig & {
            query_timeout: number;
          })
        : await current.query(text, params);
      return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
    } catch (error) {
      if (timeoutMs || isConnectionError(error)) retirePool(current);
      throw error;
    }
  }
  async function q(text: string, params: unknown[] = []): Promise<Rows> {
    return (await query(text, params)).rows;
  }
  async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const current = await pool();
    return withPgTransaction(current, fn, (error) => {
      if (isConnectionError(error)) retirePool(current);
    });
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const active = poolP;
    poolP = null;
    let initError: unknown;
    const targets = new Set(retiredPools);
    if (active) {
      try {
        targets.add(await active);
      } catch (error) {
        initError = error;
      }
    }
    const results = await Promise.allSettled([...targets].map(endPool));
    const closeError = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    if (initError) throw initError;
    if (closeError) throw closeError;
  }
  async function applySchema(schemaSql: string): Promise<void> {
    const stmt = schemaSql.trim();
    assertOneStatement(stmt);
    await applyDdl(await pool(), [stmt]);
  }
  return { pool, q, query, transaction, schema: applySchema, close };
}
