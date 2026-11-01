import { PgBoss } from "pg-boss";
import { createPgPool, type PgPool } from "./pg-pool.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

export interface SharedPgBoss {
  boss: PgBoss;
  retain(): Promise<void>;
  release(): Promise<void>;
}

const shared = new Map<string, SharedPgBoss>();

export function sharedPgBoss(databaseUrl: string, schema = "pgboss"): SharedPgBoss {
  const key = `${schema}\n${databaseUrl}`;
  const existing = shared.get(key);
  if (existing) return existing;
  let pg: PgPool | null = null;
  let started: Promise<unknown> | null = null;
  let stopping: Promise<void> | null = null;
  let users = 0;
  const boss = new PgBoss({
    schema,
    db: {
      executeSql: async (text, values) => {
        if (!pg) throw new Error("pg-boss database is closed");
        return (await pg.pool()).query(text, values);
      },
    },
  });
  boss.on("error", (e) => console.error("[pg-boss] error:", errMessage(e)));
  const shutdown = (): Promise<void> =>
    (stopping = (async () => {
      try {
        await boss.stop({ close: true, graceful: false });
      } finally {
        const previous = pg;
        pg = null;
        started = null;
        await previous?.close();
      }
    })().finally(() => {
      stopping = null;
    }));
  const handle: SharedPgBoss = {
    boss,
    async retain() {
      await stopping;
      users++;
      if (!started) {
        pg = createPgPool(databaseUrl);
        started = boss.start();
      }
      try {
        await started;
      } catch (e) {
        if (--users === 0) await shutdown().catch(swallowAs("pg-boss: stop after failed start", undefined));
        throw e;
      }
    },
    async release() {
      if (--users > 0) return;
      await shutdown();
    },
  };
  shared.set(key, handle);
  return handle;
}
