import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ItemsCopyOperator } from "../scripts/ops/items-copy.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";

const url = process.env.DATABASE_URL;

test(
  "sliced copy workers resume one cursor, copy every row once and wait out schema migrations",
  { skip: !url, timeout: 60000 },
  async () => {
    const pool = new pg.Pool({ connectionString: url });
    const clients = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        return c;
      }),
    );
    const [main, migrator, ...workers] = clients as [pg.Client, pg.Client, ...pg.Client[]];
    try {
      createPostgresSessionStore(url!);
      createPostgresDirectoryStore(url!);
      await applyPgMigrations(
        pool,
        registeredPgMigrations(url!).filter(
          (m) => m.id !== "sessions/store/0035-items" && m.id !== "sessions/store/0036-items-cutover",
        ),
      );
      await main.query(`INSERT INTO sessions(id,type,scope_id,thread_ref,created_at)
      SELECT 's'||lpad(i::text,3,'0'),'dm','personal:test','s'||i,1 FROM generate_series(0,199) i`);
      await main.query(`INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at)
      SELECT 's'||lpad((i%200)::text,3,'0'),i/200,'user',json_build_object('text','line '||i)::text,'personal:test',1
        FROM generate_series(0,1999) i`);
      const op = new ItemsCopyOperator(main, 50);
      await op.prepare();
      assert.equal(await op.copyBatch(), 50);
      assert.equal(await op.split(4), 4);
      assert.equal(await op.split(4), 4);
      await assert.rejects(op.split(3), /already split into 4 slices/);
      const slices = (await main.query("SELECT slice FROM items_copy_ops.slices ORDER BY slice")).rows.map(
        (r) => r.slice,
      );
      await migrator.query("SELECT pg_advisory_lock(hashtext('qm:schema-migrations'))");
      const release = setTimeout(
        () => void migrator.query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))"),
        1500,
      );
      await Promise.all(
        slices.map(async (slice, i) => {
          const w = new ItemsCopyOperator(workers[i]!, 50);
          while (await w.copyBatch(slice)) continue;
        }),
      );
      clearTimeout(release);
      assert.equal(await op.completeCopy(), true);
      const status = await op.status();
      assert.deepEqual(
        [status.phase, Number(status.scanned), Number(status.initial_copied), status.done],
        ["catchup", 2000, 2000, 4],
      );
      assert.equal((await main.query("SELECT count(DISTINCT (session_id,seq))::int AS n FROM items")).rows[0].n, 2000);
      await op.verify();
      assert.equal((await op.status()).phase, "verified");
    } finally {
      await Promise.all(clients.map((c) => c.end()));
      await pool.end();
    }
  },
);
