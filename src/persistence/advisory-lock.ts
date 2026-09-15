import type { PgPool } from "./pg-pool.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { asError } from "../util/errors.ts";

export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  tryWithLock?<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ADVISORY_LOCK_POLL_MS = 300;

export function createNoopAdvisoryLock(): AdvisoryLock {
  return {
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async tryWithLock<T>(_key: string, fn: () => Promise<T>): Promise<T | null> {
      return fn();
    },
  };
}

export function createMemoryAdvisoryLock(): AdvisoryLock {
  const queue = createKeyedQueue<string>();
  const held = new Set<string>();
  const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
    queue(key, async () => {
      held.add(key);
      try {
        return await fn();
      } finally {
        held.delete(key);
      }
    });
  return {
    withLock,
    async tryWithLock(key, fn) {
      if (held.has(key)) return null;
      return withLock(key, fn);
    },
  };
}

export function createPostgresAdvisoryLock(
  pg: PgPool,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): AdvisoryLock {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADVISORY_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ADVISORY_LOCK_POLL_MS;

  async function attempt<T>(key: string, fn: () => Promise<T>): Promise<{ value: T } | null> {
    const client = await (await pg.sessionPool()).connect();
    let connectionError: Error | undefined;
    let destroy = false;
    let acquired = false;
    const onError = (error: Error) => {
      connectionError ??= error;
      destroy = true;
    };
    client.on("error", onError);
    try {
      const res = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [key],
      );
      if (connectionError) throw connectionError;
      if (res.rows[0]?.locked !== true) return null;
      acquired = true;
      let value: T;
      try {
        value = await fn();
      } finally {
        if (!connectionError) {
          try {
            const unlocked = await client.query<{ released: boolean }>(
              "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released",
              [key],
            );
            if (unlocked.rows[0]?.released !== true) {
              onError(new Error(`Postgres advisory lock was lost: ${key}`));
            }
          } catch (error) {
            onError(asError(error));
          }
        }
      }
      if (connectionError) throw connectionError;
      return { value };
    } catch (error) {
      if (!acquired) destroy = true;
      throw error;
    } finally {
      client.release(destroy);
      client.removeListener("error", onError);
    }
  }

  return {
    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = await attempt(key, fn);
        if (result) return result.value;
        if (Date.now() >= deadline) throw new Error(`timeout acquiring advisory lock for ${key}`);
        await sleep(pollMs);
      }
    },

    async tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
      const result = await attempt(key, fn);
      return result ? result.value : null;
    },
  };
}
