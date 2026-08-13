import type { PgPool } from "./pg-pool.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";

export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
  tryWithLock?<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T | null>;
}

const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ADVISORY_LOCK_POLL_MS = 300;

export function createNoopAdvisoryLock(): AdvisoryLock {
  return {
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async tryWithLock<T>(
      _key: string,
      fn: () => Promise<T>,
      opts?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<T | null> {
      if (opts?.signal?.aborted) throw new Error("advisory lock acquisition cancelled");
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
    async tryWithLock(key, fn, opts) {
      if (opts?.signal?.aborted) throw new Error("advisory lock acquisition cancelled");
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

  const bounded = async <T>(
    pending: Promise<T>,
    wait: { signal?: AbortSignal; timeoutMs?: number } | undefined,
    onInterrupt?: (error: Error) => void,
  ): Promise<T> => {
    if (!wait?.signal && wait?.timeoutMs === undefined) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let interrupted = false;
    const interruption = new Promise<never>((_resolve, reject) => {
      const fail = (error: Error) => {
        if (interrupted) return;
        interrupted = true;
        onInterrupt?.(error);
        reject(error);
      };
      if (wait.signal?.aborted) return fail(new Error("advisory lock acquisition cancelled"));
      if (wait.signal) {
        onAbort = () => fail(new Error("advisory lock acquisition cancelled"));
        wait.signal.addEventListener("abort", onAbort, { once: true });
        if (wait.signal.aborted) onAbort();
      }
      if (wait.timeoutMs !== undefined) {
        timer = setTimeout(() => fail(new Error("advisory lock acquisition timed out")), Math.max(1, wait.timeoutMs));
      }
    });
    try {
      return await Promise.race([pending, interruption]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) wait.signal?.removeEventListener("abort", onAbort);
      if (interrupted) void pending.catch(() => undefined);
    }
  };

  const connect = async (
    pool: Awaited<ReturnType<PgPool["pool"]>>,
    wait?: { signal?: AbortSignal; timeoutMs?: number },
  ) => {
    const pending = pool.connect();
    return bounded(
      pending,
      wait,
      () =>
        void pending.then(
          (client) => client.release(),
          () => undefined,
        ),
    );
  };

  return {
    async withLock<T>(
      key: string,
      fn: () => Promise<T>,
      wait: { signal?: AbortSignal; timeoutMs?: number } = {},
    ): Promise<T> {
      const deadline = Date.now() + (wait.timeoutMs ?? timeoutMs);
      const remaining = () => Math.max(1, deadline - Date.now());
      const pool = await bounded(pg.pool(), { signal: wait.signal, timeoutMs: remaining() });
      for (;;) {
        const client = await connect(pool, { signal: wait.signal, timeoutMs: remaining() });
        let destroyed = false;
        try {
          const res = await bounded(
            client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key]),
            { signal: wait.signal, timeoutMs: remaining() },
            (error) => {
              destroyed = true;
              client.release(error);
            },
          );
          const held = res.rows[0]?.locked === true;
          if (held) {
            let result: T | undefined;
            let runError: unknown;
            try {
              result = await fn();
            } catch (error) {
              runError = error;
            }
            try {
              await bounded(client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]), {
                timeoutMs,
              });
            } catch (error) {
              destroyed = true;
              client.release(error instanceof Error ? error : new Error(String(error)));
              if (runError)
                throw new AggregateError([runError, error], "advisory lock body and unlock failed", { cause: error });
              throw error;
            }
            if (runError) throw runError;
            return result as T;
          }
        } finally {
          if (!destroyed) client.release();
        }
        if (Date.now() >= deadline) throw new Error(`timeout acquiring advisory lock for ${key}`);
        await bounded(sleep(pollMs), { signal: wait.signal, timeoutMs: remaining() });
      }
    },

    async tryWithLock<T>(
      key: string,
      fn: () => Promise<T>,
      wait?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<T | null> {
      const deadline = Date.now() + (wait?.timeoutMs ?? timeoutMs);
      const remaining = () => Math.max(1, deadline - Date.now());
      const boundedWait = () => ({ signal: wait?.signal, timeoutMs: remaining() });
      const pool = await bounded(pg.pool(), boundedWait());
      const client = await connect(pool, boundedWait());
      let destroyed = false;
      try {
        const res = await bounded(
          client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key]),
          boundedWait(),
          (error) => {
            destroyed = true;
            client.release(error);
          },
        );
        if (res.rows[0]?.locked !== true) return null;
        let result: T | undefined;
        let runError: unknown;
        try {
          result = await fn();
        } catch (error) {
          runError = error;
        }
        try {
          await bounded(client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]), {
            timeoutMs: wait?.timeoutMs ?? timeoutMs,
          });
        } catch (error) {
          destroyed = true;
          client.release(error instanceof Error ? error : new Error(String(error)));
          if (runError)
            throw new AggregateError([runError, error], "advisory lock body and unlock failed", { cause: error });
          throw error;
        }
        if (runError) throw runError;
        return result as T;
      } finally {
        if (!destroyed) client.release();
      }
    },
  };
}
