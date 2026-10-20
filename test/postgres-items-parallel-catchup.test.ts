import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { ItemsCopyOperator, catchupParallel } from "../scripts/ops/items-copy.ts";

const base = process.env.DATABASE_URL;
const skip = !base;

async function fixture(fn: (client: pg.Client, url: string, op: ItemsCopyOperator) => Promise<void>) {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  const name = `parallel_${randomUUID().replaceAll("-", "")}`;
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
    await catchupParallel(target.toString(), 20, 4, () => {});
    await fn(client, target.toString(), op);
  } finally {
    await client.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
}

test("parallel catchup reconciles edits, deletes, new rows, and passes full verification", { skip }, async () => {
  await fixture(async (client, url, op) => {
    await client.query(`UPDATE session_entries SET payload='{"text":"changed"}' WHERE seq=0`);
    await client.query(`DELETE FROM session_entries WHERE seq=2`);
    await client.query(`INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at)
      SELECT id,7,'assistant','{"text":"new"}','personal:alice',1700000000007 FROM sessions`);
    await catchupParallel(url, 2, 4, () => {});
    assert.equal((await client.query("SELECT count(*)::int AS n FROM items_copy_ops.dirty")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM items WHERE seq=2")).rows[0].n, 0);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM items WHERE text='changed'")).rows[0].n, 32);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM items WHERE text='new'")).rows[0].n, 32);
    await op.verify();
  });
});

test("distinct partitions enter copy concurrently without claiming the same session", { skip }, async () => {
  await fixture(async (client, url) => {
    await client.query("UPDATE session_entries SET payload=payload WHERE seq=0");
    const seen = new Set<string>();
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let allEntered!: () => void;
    const ready = new Promise<void>((resolve) => {
      allEntered = resolve;
    });
    class Gated extends ItemsCopyOperator {
      override async replaceSelected() {
        const id = (await this.client.query("SELECT DISTINCT session_id FROM pg_temp.items_copy_batch")).rows[0]
          .session_id;
        assert.ok(!seen.has(id));
        seen.add(id);
        if (++entered === 4) allEntered();
        await gate;
        return super.replaceSelected();
      }
    }
    const clients = Array.from({ length: 4 }, () => new pg.Client({ connectionString: url }));
    await Promise.all(clients.map((c) => c.connect()));
    const pending = clients.map((c, i) => new Gated(c, 2).catchupBatch(i, 4));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("workers did not overlap")), 1500);
        }),
      ]);
      assert.equal(entered, 4);
    } finally {
      clearTimeout(timer);
      release();
      await Promise.allSettled(pending);
      await Promise.all(clients.map((c) => c.end()));
    }
    assert.ok((await Promise.all(pending)).every((n) => n === 2));
  });
});

test("saved cursors resume and an edit behind the cursor triggers another complete pass", { skip }, async () => {
  await fixture(async (client, url, op) => {
    await client.query("UPDATE session_entries SET payload=payload WHERE session_id='s0' AND seq=0");
    await op.catchupBatch();
    const before = (
      await client.query("SELECT cursor_seq,copy_version,version FROM items_copy_ops.dirty WHERE session_id='s0'")
    ).rows[0];
    assert.equal(before.cursor_seq, 1);
    await client.query(
      `UPDATE session_entries SET payload='{"text":"changed-behind-cursor"}' WHERE session_id='s0' AND seq=0`,
    );
    await catchupParallel(url, 2, 4, () => {});
    assert.equal(
      (await client.query("SELECT text FROM items WHERE session_id='s0' AND seq=0")).rows[0].text,
      "changed-behind-cursor",
    );
    await op.verify();
  });
});

test("aborted parallel work preserves the queue and invalid worker counts are rejected", { skip }, async () => {
  await fixture(async (client, url, op) => {
    await client.query("UPDATE session_entries SET payload=payload WHERE seq=0");
    for (const count of [0, -1, 33, 1.5, NaN])
      await assert.rejects(
        catchupParallel(url, 2, count, () => {}),
        /workers must/,
      );
    await assert.rejects(catchupParallel(url, 2, 4, () => {}, AbortSignal.abort()));
    assert.equal((await client.query("SELECT count(*)::int AS n FROM items_copy_ops.dirty")).rows[0].n, 32);
    await catchupParallel(url, 2, 4, () => {});
    await op.verify();
  });
});

test("worker failures close all worker connections and retain retryable queue state", { skip }, async () => {
  await fixture(async (client, url, op) => {
    await client.query(
      `UPDATE session_entries SET type='system',payload='{"kind":"not-real"}' WHERE session_id='s0' AND seq=0`,
    );
    await assert.rejects(
      catchupParallel(url, 2, 4, () => {}),
      /unmapped system entry/,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='qm-items-copy'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM items_copy_ops.dirty WHERE session_id='s0'")).rows[0].n,
      1,
    );
    await client.query(
      `UPDATE session_entries SET type='user',payload='{"text":"repaired"}' WHERE session_id='s0' AND seq=0`,
    );
    await catchupParallel(url, 2, 4, () => {});
    await op.verify();
  });
});
