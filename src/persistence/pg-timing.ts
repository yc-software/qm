import { AsyncResource } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { requestTiming } from "../../plugins/chassis/src/server-timing.ts";

type ConnectCallback = (err: Error | undefined, client: PoolClient | undefined, release: (err?: Error) => void) => void;

export function timePoolWait(pool: Pool): void {
  const connect = pool.connect.bind(pool) as (callback?: ConnectCallback) => Promise<PoolClient> | undefined;
  pool.connect = ((callback?: ConnectCallback) => {
    const timing = requestTiming();
    const started = performance.now();
    const waited = () => {
      if (timing) timing.db.waitMs += performance.now() - started;
    };
    if (callback)
      return connect(
        AsyncResource.bind((err: Error | undefined, client: PoolClient | undefined, release: (err?: Error) => void) => {
          waited();
          callback(err, client, release);
        }),
      );
    return timing ? connect()!.finally(waited) : connect();
  }) as Pool["connect"];
}

export function timeClientQueries(client: PoolClient): void {
  const query = (...args: unknown[]) => Reflect.apply(Object.getPrototypeOf(client).query, client, args) as unknown;
  client.query = ((...args: unknown[]) => {
    const timing = requestTiming();
    if (!timing) return query(...args);
    const started = performance.now();
    const finished = () => {
      timing.db.queries++;
      timing.db.queryMs += performance.now() - started;
    };
    const callback = args.at(-1);
    if (typeof callback === "function") {
      args[args.length - 1] = (...result: unknown[]) => {
        finished();
        (callback as (...result: unknown[]) => void)(...result);
      };
      return query(...args);
    }
    const result = query(...args);
    if (result instanceof Promise) result.then(finished, finished);
    return result;
  }) as PoolClient["query"];
}
