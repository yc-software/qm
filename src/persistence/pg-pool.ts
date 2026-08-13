import type { Pool, PoolClient, PoolConfig } from "pg";
import { swallowAs } from "../util/errors.ts";

export type { Pool, PoolClient };

export type Rows = Record<string, unknown>[];

const CHECKOUT_TIMEOUT_MS = 5_000;

export interface PgPool {
  connect(): Promise<PoolClient>;
  q(text: string, params?: unknown[]): Promise<Rows>;
  query(text: string, params?: unknown[]): Promise<{ rows: Rows; rowCount: number }>;
  schema?(schemaSql: string): Promise<void>;
  close(): Promise<void>;
}

export interface PgListener {
  close(): void;
}

export async function withPgTransaction<T>(
  pg: Pick<PgPool, "connect">,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pg.connect();
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

export function createPgListener(
  pg: Pick<PgPool, "connect">,
  channel: string,
  onNotification: (payload: string) => void,
  onReconnect: () => void = () => {},
): PgListener {
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`invalid Postgres listener channel: ${channel}`);
  let client: PoolClient | null = null;
  let connecting = false;
  let closed = false;
  let established = false;
  let attempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const onNotificationMessage = (message: { channel: string; payload?: string }): void => {
    if (message.channel === channel && message.payload !== undefined) onNotification(message.payload);
  };
  const onError = (error: unknown): void => {
    const target = client;
    if (!target) return;
    drop(target);
    swallowAs("pg-listener: connection", undefined)(error);
    schedule();
  };

  function drop(target: PoolClient): void {
    if (client !== target) return;
    client = null;
    target.removeListener("notification", onNotificationMessage);
    target.removeListener("error", onError);
    try {
      target.release(true);
    } catch (e) {
      swallowAs("pg-listener: client release", undefined)(e);
    }
  }

  function schedule(): void {
    if (closed || reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
    attempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  async function connect(): Promise<void> {
    if (closed || connecting || client) return;
    connecting = true;
    try {
      const next = await pg.connect();
      client = next;
      next.on("notification", onNotificationMessage);
      next.once("error", onError);
      if (closed) {
        drop(next);
        return;
      }
      await next.query(`LISTEN ${channel}`);
      attempts = 0;
      if (established) onReconnect();
      established = true;
    } catch (e) {
      if (client) drop(client);
      swallowAs("pg-listener: connect", undefined)(e);
    } finally {
      connecting = false;
      if (!closed && !client) schedule();
    }
  }

  void connect();
  return {
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (client) drop(client);
    },
  };
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

async function applyDdl(pg: Pick<Pool, "connect">, statements: string[]): Promise<void> {
  const ddl = await pg.connect();
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

export function createPgPool(
  connectionString: string,
  statements: string[],
  options: Omit<PoolConfig, "connectionString"> = {},
): PgPool {
  const schema = statements.map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of schema) assertOneStatement(stmt);
  let poolP: Promise<Pool> | null = null;
  let closeP: Promise<void> | null = null;
  function pool(): Promise<Pool> {
    if (closeP) return Promise.reject(new Error("pg-pool is closed"));
    if (!poolP) {
      poolP = (async () => {
        const pg = (await import("pg")).default;
        const p = new pg.Pool({
          connectionTimeoutMillis: 10_000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10_000,
          ...options,
          connectionString,
        });
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
  async function connect(): Promise<PoolClient> {
    let lastError: unknown = new Error("pg-pool validation failed");
    for (let attempt = 0; attempt <= (options.max ?? 10); attempt++) {
      const client = await (await pool()).connect();
      const onError = swallowAs("pg-pool: checked-out client error", undefined);
      const release = client.release.bind(client);
      client.on("error", onError);
      client.release = (error?: Error | boolean) => {
        client.removeListener("error", onError);
        release(error);
      };
      const validation = client.query("SELECT 1");
      validation.catch(() => {});
      let timeout: NodeJS.Timeout | null = null;
      try {
        await Promise.race([
          validation,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("pg-pool checkout validation timed out")), CHECKOUT_TIMEOUT_MS);
            timeout.unref?.();
          }),
        ]);
        return client;
      } catch (e) {
        lastError = e;
        try {
          client.release(true);
        } catch (releaseError) {
          swallowAs("pg-pool: stale client release", undefined)(releaseError);
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    throw lastError;
  }
  async function query(text: string, params: unknown[] = []): Promise<{ rows: Rows; rowCount: number }> {
    const client = await connect();
    try {
      const res = await client.query(text, params);
      return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
    } finally {
      client.release();
    }
  }
  async function q(text: string, params: unknown[] = []): Promise<Rows> {
    return (await query(text, params)).rows;
  }
  async function close(): Promise<void> {
    if (!closeP) {
      const pending = poolP;
      closeP = pending ? pending.then((p) => p.end()) : Promise.resolve();
    }
    await closeP;
  }
  async function applySchema(schemaSql: string): Promise<void> {
    const stmt = schemaSql.trim();
    assertOneStatement(stmt);
    await applyDdl({ connect }, [stmt]);
  }
  return { connect, q, query, schema: applySchema, close };
}
