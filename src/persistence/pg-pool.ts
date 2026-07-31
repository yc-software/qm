import type { Pool, PoolClient } from "pg";
import { swallowAs } from "../util/errors.ts";
import { errMessage } from "../util/errors.ts";

export type { Pool, PoolClient };

export type Rows = Record<string, unknown>[];

export interface PgPool {
  pool(): Promise<Pool>;
  q(text: string, params?: unknown[]): Promise<Rows>;
  query(text: string, params?: unknown[]): Promise<{ rows: Rows; rowCount: number }>;
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
        p.on("error", (err) => console.error("[pg] idle client error:", errMessage(err)));
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
  async function query(text: string, params: unknown[] = []): Promise<{ rows: Rows; rowCount: number }> {
    const res = await (await pool()).query(text, params);
    return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
  }
  async function q(text: string, params: unknown[] = []): Promise<Rows> {
    return (await query(text, params)).rows;
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
