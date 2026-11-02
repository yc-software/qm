import type { PgPool, Sql } from "./pg-pool.ts";
import { pgRun, usePg } from "./pg-driver.ts";
import { swallow } from "../util/errors.ts";

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
    cp: Promise<Sql>;
    lost: Set<() => void>;
  }
  let conn: Conn | null = null;
  const held = new Set<string>();

  function drop(entry: Conn, c: Sql): void {
    if (conn !== entry) return;
    conn = null;
    for (const notify of entry.lost) notify();
    entry.lost.clear();
    c.end({ timeout: 0 }).catch((e: unknown) => swallow("leader-lease: lock connection close failed", e));
  }

  function client(): Conn {
    if (!conn) {
      const entry: Conn = { cp: undefined as unknown as Promise<Sql>, lost: new Set() };
      entry.cp = pg.dedicated({
        onclose: () => {
          if (conn !== entry) return;
          swallow("leader-lease: lock connection died (its locks auto-released)", new Error("connection closed"));
          void entry.cp.then((c) => drop(entry, c));
        },
      });
      entry.cp.catch(() => {
        if (conn === entry) conn = null;
      });
      conn = entry;
    }
    return conn;
  }

  async function lead<T>(entry: Conn, c: Sql, key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
    let won: boolean;
    try {
      const res = await pgRun<{ won: boolean }>(c, "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS won", [
        `leader-lease:${key}`,
      ]);
      won = res.rows[0]?.won === true;
    } catch (e) {
      drop(entry, c);
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
        const res = await pgRun<{ released: boolean }>(
          c,
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
          [`leader-lease:${key}`],
        );
        if (res.rows[0]?.released !== true) {
          console.error(
            `[leader-lease] unlock of ${key} reported not-held — is DATABASE_URL behind a transaction-pooling proxy?`,
          );
          drop(entry, c);
        }
      } catch (e) {
        swallow(`leader-lease: unlock of ${key} failed; dropping the lock connection`, e);
        drop(entry, c);
      }
    }
  }

  return {
    async hold<T>(key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      if (held.has(key)) return null;
      held.add(key);
      try {
        const entry = client();
        const c = await entry.cp;
        return await usePg(c, () => lead(entry, c, key, fn));
      } finally {
        held.delete(key);
      }
    },
  };
}
