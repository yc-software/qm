import { AsyncLocalStorage } from "node:async_hooks";
import type { PgPool, PoolClient } from "./pg-pool.ts";
import { sleep } from "../util/async.ts";

export interface AdvisoryLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  withSharedLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
  tryWithLock?<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

const DEFAULT_ADVISORY_LOCK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ADVISORY_LOCK_POLL_MS = 300;

export function createNoopAdvisoryLock(): AdvisoryLock {
  return {
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async withSharedLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async tryWithLock<T>(_key: string, fn: () => Promise<T>): Promise<T | null> {
      return fn();
    },
  };
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
  return {
    withLock: (key, fn) => run(key, fn, false),
    withSharedLock: (key, fn) => run(key, fn, true),
    async tryWithLock(key, fn) {
      if (states.has(key)) return null;
      return run(key, fn, false);
    },
  };
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
          const res = await client.query<{ locked: boolean }>(
            `SELECT pg_try_advisory_lock${shared ? "_shared" : ""}(hashtextextended($1, 0)) AS locked`,
            [key],
          );
          if (res.rows[0]?.locked !== true) return { acquired: false };
          try {
            return { acquired: true, value: await fn() };
          } finally {
            await client.query(`SELECT pg_advisory_unlock${shared ? "_shared" : ""}(hashtextextended($1, 0))`, [key]);
          }
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
  return {
    withLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, false, true) as Promise<T>,
    withSharedLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, true, true) as Promise<T>,
    tryWithLock: <T>(key: string, fn: () => Promise<T>) => run(key, fn, false, false),
  };
}
