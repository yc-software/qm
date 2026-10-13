import { AsyncLocalStorage } from "node:async_hooks";
import type { PgPool, PoolClient } from "./pg-pool.ts";
import { sleep } from "../util/async.ts";
import { reportFailure, withCleanup } from "../util/errors.ts";

export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  withSharedLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
  tryWithLocks?<T>(keys: string[], fn: () => Promise<T>): Promise<T | null>;
  tryWithLock?<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

function withMultiLocks(lock: AdvisoryLock): AdvisoryLock {
  const multi = new AsyncLocalStorage<{ keys: Set<string>; active: boolean; pending: Set<Promise<unknown>> }>();
  return {
    ...lock,
    withLock: (key, fn) => {
      const scope = multi.getStore();
      if (!scope?.active || !scope.keys.has(key)) return lock.withLock(key, fn);
      const work = Promise.resolve().then(fn);
      scope.pending.add(work);
      void work.then(
        () => scope.pending.delete(work),
        () => scope.pending.delete(work),
      );
      return work;
    },
    async tryWithLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T | null> {
      const unique = [...new Set(keys)].sort();
      const scope = { keys: new Set(unique), active: true, pending: new Set<Promise<unknown>>() };
      const acquire = (index: number): Promise<T | null> =>
        index === unique.length
          ? multi.run(scope, async () => {
              try {
                return await fn();
              } finally {
                while (scope.pending.size) await Promise.allSettled(scope.pending);
                scope.active = false;
              }
            })
          : lock.tryWithLock!(unique[index]!, () => acquire(index + 1));
      try {
        return await acquire(0);
      } finally {
        scope.active = false;
      }
    },
  };
}

const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ADVISORY_LOCK_POLL_MS = 300;

export function createNoopAdvisoryLock(): AdvisoryLock {
  return withMultiLocks({
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async withSharedLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async tryWithLock<T>(_key: string, fn: () => Promise<T>): Promise<T | null> {
      return fn();
    },
  });
}

export function createMemoryAdvisoryLock(): AdvisoryLock {
  const states = new Map<string, { tail: Promise<void>; readers: Set<Promise<void>>; pending: number }>();
  const run = async <T>(key: string, fn: () => Promise<T>, shared: boolean): Promise<T> => {
    let state = states.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), readers: new Set(), pending: 0 };
      states.set(key, state);
    }
    const done = Promise.withResolvers<void>();
    const before = shared ? state.tail : Promise.all([state.tail, ...state.readers]);
    state.pending++;
    if (shared) state.readers.add(done.promise);
    else state.tail = done.promise;
    try {
      await before;
      return await fn();
    } finally {
      state.readers.delete(done.promise);
      state.pending--;
      done.resolve();
      if (!state.pending) states.delete(key);
    }
  };
  return withMultiLocks({
    withLock: (key, fn) => run(key, fn, false),
    withSharedLock: (key, fn) => run(key, fn, true),
    async tryWithLock(key, fn) {
      if (states.has(key)) return null;
      return run(key, fn, false);
    },
  });
}

export function createPostgresAdvisoryLock(
  pg: PgPool,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): AdvisoryLock {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ADVISORY_LOCK_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ADVISORY_LOCK_POLL_MS;

  type Context = {
    client: PoolClient;
    references: number;
    broken: boolean;
    brokenBy?: unknown;
    onError: () => void;
    keys: Map<string, { shared: boolean; count: number }>;
  };
  const sessions = new AsyncLocalStorage<{ context: Context; active: boolean }>();
  const withClient = async <T>(action: (context: Context) => Promise<T>): Promise<T> => {
    const parent = sessions.getStore();
    let context: Context;
    if (parent?.active) context = parent.context;
    else {
      context = {
        client: await (await pg.sessionPool()).connect(),
        references: 0,
        broken: false,
        onError: (error?: unknown) => {
          context.broken = true;
          context.brokenBy = error;
        },
        keys: new Map(),
      };
      context.client.on("error", context.onError);
    }
    if (context.broken) throw new Error("advisory lock session is no longer available", { cause: context.brokenBy });
    context.references++;
    const lease = { context, active: true };
    try {
      return await sessions.run(lease, () => action(context));
    } finally {
      lease.active = false;
      if (--context.references === 0) {
        context.client.removeListener("error", context.onError);
        context.client.release(context.broken);
      }
    }
  };
  const run = async <T>(key: string, fn: () => Promise<T>, shared: boolean, wait: boolean): Promise<T | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const attempt = await withClient(async (context): Promise<{ acquired: false } | { acquired: true; value: T }> => {
        const { client, keys } = context;
        const held = keys.get(key);
        if (held && !(shared && held.shared)) return { acquired: false };
        const reservation = held ?? { shared, count: 0 };
        reservation.count++;
        keys.set(key, reservation);
        try {
          let acquired = false;
          let completed = false;
          return await withCleanup(
            async () => {
              try {
                const res = await client.query<{ locked: boolean }>(
                  `SELECT pg_try_advisory_lock${shared ? "_shared" : ""}(hashtextextended($1, 0)) AS locked`,
                  [key],
                );
                acquired = res.rows[0]?.locked === true;
              } catch (error) {
                context.broken = true;
                context.brokenBy = error;
                throw error;
              }
              if (!acquired) return { acquired: false };
              const value = await fn();
              completed = true;
              return { acquired: true, value };
            },
            async () => {
              if (!acquired) return;
              try {
                await client.query(`SELECT pg_advisory_unlock${shared ? "_shared" : ""}(hashtextextended($1, 0))`, [
                  key,
                ]);
              } catch (error) {
                context.broken = true;
                context.brokenBy = error;
                if (!completed) throw error;
                reportFailure("advisory-lock: unlock", error);
              }
            },
          );
        } finally {
          if (--reservation.count === 0) keys.delete(key);
        }
      });
      if (attempt.acquired) return attempt.value;
      if (!wait) return null;
      if (Date.now() >= deadline) throw new Error(`timeout acquiring advisory lock for ${key}`);
      await sleep(pollMs);
    }
  };
  return withMultiLocks({
    withLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, false, true) as Promise<T>,
    withSharedLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, true, true) as Promise<T>,
    tryWithLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, false, false),
  });
}
