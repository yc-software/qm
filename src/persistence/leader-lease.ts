import { reservePg, type PgClient, type PgPool, type Sql } from "./pg-pool.ts";
import { swallow, swallowAs } from "../util/errors.ts";

export interface LeaderLease {
  hold<T>(key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null>;
}

const NEVER = new Promise<void>(() => {});

export function createNoopLeaderLease(): LeaderLease {
  return {
    async hold<T>(_key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      return fn(NEVER);
    },
  };
}

export function createPostgresLeaderLease(pg: PgPool): LeaderLease {
  interface Conn {
    cp: Promise<Lock>;
    lost: Set<() => void>;
  }
  interface Lock {
    sql: Sql;
    client: PgClient & { release(): void };
  }
  let conn: Conn | null = null;
  const held = new Set<string>();

  function drop(entry: Conn, lock: Lock): void {
    if (conn !== entry) return;
    conn = null;
    for (const notify of entry.lost) notify();
    entry.lost.clear();
    lock.client.release();
    lock.sql.end().catch(swallowAs("leader-lease: lock connection close failed", undefined));
  }

  function client(): Conn {
    if (!conn) {
      const entry: Conn = { cp: undefined as unknown as Promise<Lock>, lost: new Set() };
      entry.cp = (async () => {
        const sql = await pg.dedicated({
          onclose: (id) => {
            if (conn !== entry) return;
            console.error(`[leader-lease] lock connection ${id} closed; its advisory locks were released`);
            void entry.cp.then((lock) => drop(entry, lock));
          },
        });
        try {
          return { sql, client: await reservePg(sql) };
        } catch (error) {
          await sql.end().catch(swallowAs("leader-lease: lock connection close failed", undefined));
          throw error;
        }
      })();
      entry.cp.catch(() => {
        if (conn === entry) conn = null;
      });
      conn = entry;
    }
    return conn;
  }

  async function lead<T>(
    entry: Conn,
    lock: Lock,
    key: string,
    fn: (lost: Promise<void>) => Promise<T>,
  ): Promise<T | null> {
    let won: boolean;
    try {
      const res = await lock.client.query<{ won: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS won",
        [`leader-lease:${key}`],
      );
      won = res.rows[0]?.won === true;
    } catch (e) {
      drop(entry, lock);
      throw e;
    }
    if (!won) return null;
    let notifyLost!: () => void;
    const lost = new Promise<void>((r) => (notifyLost = r));
    entry.lost.add(notifyLost);
    try {
      return await fn(lost);
    } finally {
      entry.lost.delete(notifyLost);
      try {
        const res = await lock.client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
          [`leader-lease:${key}`],
        );
        if (res.rows[0]?.released !== true) {
          console.error(
            `[leader-lease] unlock of ${key} reported not-held — is DATABASE_URL behind a transaction-pooling proxy?`,
          );
          drop(entry, lock);
        }
      } catch (e) {
        swallow(`leader-lease: unlock of ${key} failed; dropping the lock connection`, e);
        drop(entry, lock);
      }
    }
  }

  return {
    async hold<T>(key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      if (held.has(key)) return null;
      held.add(key);
      const entry = client();
      try {
        return await lead(entry, await entry.cp, key, fn);
      } finally {
        held.delete(key);
        if (!held.size && conn === entry) drop(entry, await entry.cp);
      }
    },
  };
}
