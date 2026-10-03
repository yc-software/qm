import { AsyncLocalStorage } from "node:async_hooks";
import type { PgPool, PoolClient } from "./pg-pool.ts";
import { sleep } from "../util/async.ts";

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
    keys: Map<string, { shared: boolean; count: number }>;
  };
  const sessions = new AsyncLocalStorage<{ context: Context; active: boolean }>();
  const withClient = async <T>(action: (context: Context) => Promise<T>): Promise<T> => {
    const parent = sessions.getStore();
    const context = parent?.active
      ? parent.context
      : { client: await (await pg.sessionPool()).connect(), references: 0, keys: new Map() };
    context.references++;
    const lease = { context, active: true };
    try {
      return await sessions.run(lease, () => action(context));
    } finally {
      lease.active = false;
      if (--context.references === 0) context.client.release();
    }
  };
  const intentKey = (key: string): string => `${key}:writer-intent`;
  const tryTake = async (client: PoolClient, key: string, shared: boolean): Promise<boolean> =>
    (
      await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock${shared ? "_shared" : ""}(hashtextextended($1, 0)) AS locked`,
        [key],
      )
    ).rows[0]?.locked === true;
  const unlock = async (client: PoolClient, key: string, shared: boolean): Promise<void> => {
    await client.query(`SELECT pg_advisory_unlock${shared ? "_shared" : ""}(hashtextextended($1, 0))`, [key]);
  };
  type Intent = { client: PoolClient; owned: boolean };
  const claimIntent = async (key: string): Promise<Intent | null> => {
    const probe = await withClient(async ({ client }) => {
      if (!(await tryTake(client, key, true))) return false;
      await unlock(client, key, true);
      return true;
    });
    if (!probe) return null;
    const parent = sessions.getStore();
    if (parent?.active) {
      return (await tryTake(parent.context.client, intentKey(key), false))
        ? { client: parent.context.client, owned: false }
        : null;
    }
    let client: PoolClient;
    try {
      client = await (await pg.sessionPool()).connect();
    } catch {
      return null;
    }
    try {
      if (await tryTake(client, intentKey(key), false)) return { client, owned: true };
    } catch (error) {
      client.release(true);
      throw error;
    }
    client.release();
    return null;
  };
  const releaseIntent = async ({ client, owned }: Intent, key: string): Promise<void> => {
    try {
      await unlock(client, intentKey(key), false);
      if (owned) client.release();
    } catch (error) {
      if (!owned) throw error;
      client.release(true);
    }
  };
  const run = async <T>(key: string, fn: () => Promise<T>, shared: boolean, wait: boolean): Promise<T | null> => {
    const deadline = Date.now() + timeoutMs;
    let intent: Intent | null = null;
    const dropIntent = async (): Promise<void> => {
      if (!intent) return;
      const held = intent;
      intent = null;
      await releaseIntent(held, key);
    };
    try {
      for (;;) {
        const attempt = await withClient(
          async (context): Promise<{ acquired: false } | { acquired: true; value: T }> => {
            const { client, keys } = context;
            const held = keys.get(key);
            if (held && !(shared && held.shared)) return { acquired: false };
            const reservation = held ?? { shared, count: 0 };
            reservation.count++;
            keys.set(key, reservation);
            try {
              if (shared && !held) {
                if (!(await tryTake(client, intentKey(key), true))) return { acquired: false };
                await unlock(client, intentKey(key), true);
              }
              if (!(await tryTake(client, key, shared))) return { acquired: false };
              try {
                await dropIntent();
                return { acquired: true, value: await fn() };
              } finally {
                await unlock(client, key, shared);
              }
            } finally {
              if (--reservation.count === 0) keys.delete(key);
            }
          },
        );
        if (attempt.acquired) return attempt.value;
        if (!wait) return null;
        if (Date.now() >= deadline) throw new Error(`timeout acquiring advisory lock for ${key}`);
        if (!shared && !intent) intent = await claimIntent(key);
        await sleep(pollMs);
      }
    } finally {
      await dropIntent();
    }
  };
  return withMultiLocks({
    withLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, false, true) as Promise<T>,
    withSharedLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, true, true) as Promise<T>,
    tryWithLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, false, false),
  });
}
