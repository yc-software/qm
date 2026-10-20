import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { ItemsCopyOperator, catchupBulk } from "../scripts/ops/items-copy.ts";

const base = process.env.DATABASE_URL;
const skip = !base;

async function fixture(fn: (client: pg.Client, url: string, op: ItemsCopyOperator) => Promise<void>) {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  const name = `bulkcatch_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(base!);
  target.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const client = new pg.Client({ connectionString: target.toString() });
  const pool = new pg.Pool({ connectionString: target.toString() });
  await client.connect();
  try {
    createPostgresSessionStore(target.toString());
    createPostgresDirectoryStore(target.toString());
    await applyPgMigrations(
      pool,
      registeredPgMigrations(target.toString()).filter(
        (m) => m.id !== "sessions/store/0035-items" && m.id !== "sessions/store/0036-items-cutover",
      ),
    );
    const op = new ItemsCopyOperator(client, 2);
    await op.prepare();
    await client.query(`INSERT INTO sessions(id,type,scope_id,thread_ref,created_at)
      SELECT 's'||i,'dm','personal:alice','web:s'||i,1 FROM generate_series(0,31) i`);
    await client.query(`INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at)
      SELECT 's'||i,j,'user',json_build_object('text','old-'||j)::text,'personal:alice',1700000000000+j
      FROM generate_series(0,31) i CROSS JOIN generate_series(0,6) j`);
    await op.split(1);
    while (await op.copyBatch()) continue;
    await op.completeCopy();
    await client.query("DELETE FROM items_copy_ops.dirty");
    await fn(client, target.toString(), op);
  } finally {
    await client.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
}

const count = async (client: pg.Client, sql: string) => (await client.query(sql)).rows[0].n as number;

for (const [batch, workers] of [
  [3, 1],
  [5, 3],
  [2000, 2],
] as const)
  test(
    `bulk catchup reconciles edits, deletes, new rows and empty sessions (batch ${batch}, ${workers} workers)`,
    { skip },
    async () => {
      await fixture(async (client, url, op) => {
        await client.query(`UPDATE session_entries SET payload='{"text":"changed"}' WHERE seq=0`);
        await client.query(`DELETE FROM session_entries WHERE seq=2`);
        await client.query(`DELETE FROM session_entries WHERE session_id='s5'`);
        await client.query(`INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at)
        SELECT id,7,'assistant','{"text":"new"}','personal:alice',1700000000007 FROM sessions WHERE id<>'s5'`);
        await client.query(`UPDATE items_copy_ops.dirty SET copy_version=version,cursor_seq=3 WHERE session_id='s7'`);
        await catchupBulk(url, batch, workers, () => {});
        assert.equal(await count(client, "SELECT count(*)::int AS n FROM items_copy_ops.dirty"), 0);
        assert.equal(await count(client, "SELECT count(*)::int AS n FROM items WHERE seq=2"), 0);
        assert.equal(await count(client, "SELECT count(*)::int AS n FROM items WHERE session_id='s5'"), 0);
        assert.equal(await count(client, "SELECT count(*)::int AS n FROM items WHERE text='changed'"), 31);
        assert.equal(await count(client, "SELECT count(*)::int AS n FROM items WHERE text='new'"), 31);
        await op.verify();
      });
    },
  );

test("a session written during the pass stays queued with a reset cursor", { skip }, async () => {
  await fixture(async (client, url) => {
    await client.query(`UPDATE session_entries SET payload='{"text":"changed"}' WHERE seq=0`);
    class Racing extends ItemsCopyOperator {
      raced = false;
      override async replaceSelected() {
        const ids = (await this.client.query("SELECT DISTINCT session_id FROM pg_temp.items_copy_batch")).rows.map(
          (r) => r.session_id,
        );
        if (!this.raced && ids.includes("s3")) {
          this.raced = true;
          const other = new pg.Client({ connectionString: url });
          await other.connect();
          await other.query(`INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at)
            VALUES('s3',9,'assistant','{"text":"late"}','personal:alice',1700000000009)`);
          await other.end();
        }
        return super.replaceSelected();
      }
    }
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const op = new Racing(c, 4);
    await op.snapshotDirty();
    let cursor: { session: string; seq: number } | null = { session: "", seq: -1 };
    while (cursor) cursor = (await op.bulkCatchupBatch(cursor)).next;
    await c.end();
    const left = (await client.query("SELECT session_id,copy_version,cursor_seq FROM items_copy_ops.dirty")).rows;
    assert.deepEqual(left, [{ session_id: "s3", copy_version: null, cursor_seq: null }]);
    assert.equal(await count(client, "SELECT count(*)::int AS n FROM items WHERE text='changed'"), 32);
  });
});

test("finish drains queued sessions in bulk after an operator marks the copy verified", { skip }, async () => {
  await fixture(async (client, _url, op) => {
    await client.query(`UPDATE session_entries SET payload='{"text":"changed"}' WHERE seq=0`);
    await client.query(`DELETE FROM session_entries WHERE seq=2`);
    await client.query(`INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at)
      SELECT id,7,'assistant','{"text":"new"}','personal:alice',1700000000007 FROM sessions`);
    await op.indexes();
    await client.query("UPDATE items_copy_ops.state SET phase='verified',updated_at=now() WHERE phase='catchup'");
    await op.finish(true);
    assert.equal(await count(client, "SELECT count(*)::int AS n FROM items_copy_ops.dirty"), 0);
    assert.equal(await count(client, "SELECT count(*)::int AS n FROM items WHERE seq=2"), 0);
    assert.equal(await count(client, "SELECT count(*)::int AS n FROM items WHERE text='changed'"), 32);
    assert.equal(await count(client, "SELECT count(*)::int AS n FROM items WHERE text='new'"), 32);
    assert.equal((await client.query("SELECT phase FROM items_copy_ops.state")).rows[0].phase, "ready");
  });
});
