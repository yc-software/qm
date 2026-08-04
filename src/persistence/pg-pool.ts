import type { Pool, PoolClient } from "pg";
import { swallowAs } from "../util/errors.ts";

export type { Pool, PoolClient };

export type Rows = Record<string, unknown>[];

export interface PgQueryOptions {
  signal?: AbortSignal;
}

export interface PgPool {
  pool(): Promise<Pool>;
  q(text: string, params?: unknown[], options?: PgQueryOptions): Promise<Rows>;
  query(text: string, params?: unknown[], options?: PgQueryOptions): Promise<{ rows: Rows; rowCount: number }>;
  schema?(schemaSql: string): Promise<void>;
  close(): Promise<void>;
}

export async function withPgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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
  function pool(): Promise<Pool> {
    if (!poolP) {
      poolP = (async () => {
        const pg = (await import("pg")).default;
        const p = new pg.Pool({ connectionString });
        p.on("error", (err) => console.error("[pg] idle client error:", err));
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
    options: PgQueryOptions = {},
  ): Promise<{ rows: Rows; rowCount: number }> {
    const p = await pool();
    if (!options.signal) {
      const res = await p.query(text, params);
      return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
    }
    if (options.signal.aborted) throw new DOMException("Postgres query cancelled", "AbortError");
    const connectPromise = p.connect();
    let connectAbort: (() => void) | undefined;
    const connectAbortPromise = new Promise<never>((_, reject) => {
      connectAbort = () => reject(new DOMException("Postgres query cancelled", "AbortError"));
      options.signal!.addEventListener("abort", connectAbort, { once: true });
    });
    let client: PoolClient;
    try {
      client = await Promise.race([connectPromise, connectAbortPromise]);
    } catch (error) {
      void connectPromise
        .then(
          (lateClient) => lateClient.release(error instanceof Error ? error : new Error(String(error))),
          () => undefined,
        )
        .catch(() => undefined);
      throw error;
    } finally {
      if (connectAbort) options.signal.removeEventListener("abort", connectAbort);
    }
    let queryError: Error | undefined;
    let released = false;
    const cancel = () => {
      if (released) return;
      released = true;
      client.release(new Error("Postgres query cancelled"));
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (released) throw new Error("Postgres query cancelled");
      const res = await client.query({ text, values: params });
      return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
    } catch (error) {
      queryError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (!released) client.release(queryError);
    }
  }
  async function q(text: string, params: unknown[] = [], options?: PgQueryOptions): Promise<Rows> {
    return (await query(text, params, options)).rows;
  }
  async function close(): Promise<void> {
    if (poolP) await (await poolP).end();
  }
  async function applySchema(schemaSql: string): Promise<void> {
    const stmt = schemaSql.trim();
    assertOneStatement(stmt);
    await applyDdl(await pool(), [stmt]);
  }
  return { pool, q, query, schema: applySchema, close };
}
