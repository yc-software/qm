import { PgBoss } from "pg-boss";
import { createPgPool, type PgPool } from "./pg-pool.ts";

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
  const close = async (): Promise<void> => {
    const previous = pg;
    pg = null;
    started = null;
    await previous?.close();
  };
  const handle: SharedPgBoss = {
    boss,
    async retain() {
      users++;
      if (!started) {
        pg = createPgPool(databaseUrl);
        started = boss.start();
      }
      try {
        await started;
      } catch (e) {
        if (--users === 0) {
          await boss.stop({ close: true, graceful: false }).catch(() => {});
          await close();
        }
        throw e;
      }
    },
    async release() {
      if (--users > 0) return;
      try {
        await boss.stop({ close: true, graceful: false });
      } finally {
        await close();
      }
    },
  };
  shared.set(key, handle);
  return handle;
}
