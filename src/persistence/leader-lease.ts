import type { PgPool, PoolClient } from "./pg-pool.ts";
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
    cp: Promise<PoolClient>;
    onError: (e: unknown) => void;
    lost: Set<() => void>;
  }
  let conn: Conn | null = null;
  const held = new Set<string>();

  function drop(entry: Conn, c: PoolClient, destroy: boolean): void {
    if (conn !== entry) return;
    conn = null;
    for (const notify of entry.lost) notify();
    entry.lost.clear();
    c.removeListener("error", entry.onError);
    try {
      c.release(destroy);
    } catch (e) {
      swallow("leader-lease: client release failed", e);
    }
  }

  function client(): Conn {
    if (!conn) {
      const entry: Conn = { cp: undefined as unknown as Promise<PoolClient>, onError: () => {}, lost: new Set() };
      entry.cp = (async () => {
        const c = await (await pg.pool()).connect();
        entry.onError = (e: unknown) => {
          swallow("leader-lease: lock connection died (its locks auto-released)", e);
          drop(entry, c, true);
        };
        c.on("error", entry.onError);
        return c;
      })();
      entry.cp.catch(() => {
        if (conn === entry) conn = null;
      });
      conn = entry;
    }
    return conn;
  }

  return {
    async hold<T>(key: string, fn: (lost: Promise<void>) => Promise<T>): Promise<T | null> {
      if (held.has(key)) return null;
      held.add(key);
      const entry = client();
      try {
        const c = await entry.cp;
        let won: boolean;
        try {
          const res = await c.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS won", [
            `leader-lease:${key}`,
          ]);
          won = res.rows[0]?.won === true;
        } catch (e) {
          drop(entry, c, true);
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
            const res = await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released", [
              `leader-lease:${key}`,
            ]);
            if (res.rows[0]?.released !== true) {
              console.error(
                `[leader-lease] unlock of ${key} reported not-held — is DATABASE_URL behind a transaction-pooling proxy?`,
              );
              drop(entry, c, true);
            }
          } catch (e) {
            swallow(`leader-lease: unlock of ${key} failed; dropping the lock connection`, e);
            drop(entry, c, true);
          }
        }
      } finally {
        held.delete(key);
        void entry.cp
          .then((c) => {
            if (held.size === 0) drop(entry, c, false);
          })
          .catch(() => {});
      }
    },
  };
}
