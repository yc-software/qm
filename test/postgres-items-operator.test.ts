import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ItemsCopyOperator } from "../scripts/ops/items-copy.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresDirectoryStore } from "../src/directory/postgres-directory-store.ts";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";

const url = process.env.DATABASE_URL;
const insertSession = `INSERT INTO sessions(id,type,scope_id,thread_ref,created_at) VALUES($1,'dm','personal:test',$1,1)`;
const insertEntry = `INSERT INTO session_entries(session_id,seq,type,payload,scope_label,created_at) VALUES($1,$2,'user',$3,'personal:test',1)`;

test(
  "items operator resumes bounded copies and reconciles updates, low keys, delayed commits and cascade deletes",
  { skip: !url, timeout: 45000 },
  async () => {
    const pool = new pg.Pool({ connectionString: url });
    const client = new pg.Client({ connectionString: url });
    const writer = new pg.Client({ connectionString: url });
    await client.connect();
    await writer.connect();
    try {
      createPostgresSessionStore(url!);
      createPostgresDirectoryStore(url!);
      await applyPgMigrations(
        pool,
        registeredPgMigrations(url!).filter((m) => m.id !== "sessions/store/0035-items"),
      );
      await client.query(
        "ALTER TABLE session_entries ADD CONSTRAINT operator_source_fk FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE",
      );
      await client.query(insertSession, ["z"]);
      for (let i = 0; i < 8; i++) await client.query(insertEntry, ["z", i, JSON.stringify({ text: `line ${i}` })]);
      await client.query("UPDATE session_entries SET type='soul' WHERE seq>=6");
      const op = new ItemsCopyOperator(client, 2);
      await op.prepare();
      await assert.rejects(op.prepare(), /already exists/);
      assert.equal(await op.copyBatch(), 2);
      await writer.query("UPDATE session_entries SET payload='broken' WHERE session_id='z' AND seq=2");
      const checkpoint = await op.status();
      await assert.rejects(op.copyBatch(), /invalid input syntax/);
      assert.equal((await op.status()).scanned, checkpoint.scanned);
      await writer.query("UPDATE session_entries SET payload='{\"text\":\"fixed\"}' WHERE session_id='z' AND seq=2");
      await writer.query(insertSession, ["a"]);
      await writer.query(insertEntry, ["a", 0, '{"text":"lower key"}']);
      await writer.query("UPDATE session_entries SET payload='{\"text\":\"edit\"}' WHERE session_id='z' AND seq=0");
      await writer.query("DELETE FROM session_entries WHERE session_id='z' AND seq=1");
      await writer.query("UPDATE session_entries SET seq=12 WHERE session_id='z' AND seq=4");
      await assert.rejects(writer.query("TRUNCATE session_entries"), /TRUNCATE is disabled/);
      const resumed = new ItemsCopyOperator(client, 2);
      while (await resumed.copyBatch()) continue;
      assert.equal(await resumed.completeCopy(), true);
      assert.equal((await resumed.status()).phase, "catchup");
      await writer.query("BEGIN");
      await writer.query(insertSession, ["late"]);
      await writer.query(insertEntry, ["late", 0, '{"text":"late commit"}']);
      await client.query("UPDATE session_entries SET payload='{\"text\":\"later id\"}' WHERE session_id='z' AND seq=5");
      while (await resumed.catchupBatch()) continue;
      await writer.query("COMMIT");
      while (await resumed.catchupBatch()) continue;
      assert.equal((await resumed.status()).queued, "0");
      assert.deepEqual(
        (await client.query("SELECT session_id,seq::int,text FROM items ORDER BY session_id,seq")).rows,
        [
          { session_id: "a", seq: 0, text: "lower key" },
          { session_id: "late", seq: 0, text: "late commit" },
          { session_id: "z", seq: 0, text: "edit" },
          { session_id: "z", seq: 2, text: "fixed" },
          { session_id: "z", seq: 3, text: "line 3" },
          { session_id: "z", seq: 5, text: "later id" },
          { session_id: "z", seq: 12, text: "line 4" },
        ],
      );
      await resumed.verify();
      await client.query("UPDATE items SET text='corrupt' WHERE session_id='z' AND seq=0");
      await assert.rejects(resumed.verify(), /verification found differences/);
      await assert.rejects(resumed.finish(true), /phase changed/);
      await writer.query("UPDATE session_entries SET payload=payload WHERE session_id='z' AND seq=0");
      while (await resumed.catchupBatch()) continue;
      await resumed.verify();
      await writer.query("DELETE FROM sessions WHERE id='a'");
      while (await resumed.catchupBatch()) continue;
      assert.equal((await client.query("SELECT count(*)::int AS n FROM items WHERE session_id='a'")).rows[0].n, 0);
      await resumed.verify();
      await client.query("INSERT INTO participants(session_id,principal_id,valid_from) VALUES('z','ann',0)");
      while (await resumed.catchupBatch()) continue;
      assert.equal(
        (await client.query("SELECT author FROM items WHERE session_id='z' AND seq=0")).rows[0].author,
        "ann",
      );
      await client.query("INSERT INTO participants(session_id,principal_id,valid_from) VALUES('z','bob',0)");
      await client.query(
        'UPDATE session_entries SET payload=\'{"text":"edit","name":"Ann","ts":"1.1"}\' WHERE session_id=\'z\' AND seq=0',
      );
      await client.query(
        "INSERT INTO directory_members(org_id,principal_id,display_name,display_name_lc,type) VALUES('o','ann','Ann','ann','internal')",
      );
      while (await resumed.catchupBatch()) continue;
      assert.equal(
        (await client.query("SELECT author FROM items WHERE session_id='z' AND seq=0")).rows[0].author,
        "ann",
      );
      await client.query("DELETE FROM directory_members WHERE principal_id='ann'");
      while (await resumed.catchupBatch()) continue;
      assert.equal(
        (await client.query("SELECT author FROM items WHERE session_id='z' AND seq=0")).rows[0].author,
        null,
      );
      await client.query(insertEntry, ["z", 15, '{"thinking":"thought"}']);
      await client.query("UPDATE session_entries SET type='thinking' WHERE session_id='z' AND seq=15");
      await client.query(
        'INSERT INTO legacy_tape_steps(session_id,seq,step) VALUES(\'z\',15,\'{"index":3,"model":"m"}\')',
      );
      while (await resumed.catchupBatch()) continue;
      assert.equal((await client.query("SELECT step FROM items WHERE session_id='z' AND seq=15")).rows[0].step, 3);
      await client.query(insertEntry, ["z", 20, '{"kind":"message_revision","ts":"9.1"}']);
      await client.query("UPDATE session_entries SET type='system' WHERE session_id='z' AND seq=20");
      while (await resumed.catchupBatch()) continue;
      assert.equal(
        (await client.query("SELECT target_seq FROM items WHERE session_id='z' AND seq=20")).rows[0].target_seq,
        null,
      );
      await client.query(
        'UPDATE session_entries SET payload=\'{"text":"new first","ts":"9.1"}\' WHERE session_id=\'z\' AND seq=0',
      );
      await resumed.catchupBatch();
      await client.query(
        'UPDATE session_entries SET payload=\'{"text":"newer first","ts":"9.1"}\' WHERE session_id=\'z\' AND seq=0',
      );
      while (await resumed.catchupBatch()) continue;
      assert.equal(
        (await client.query("SELECT target_seq::int FROM items WHERE session_id='z' AND seq=20")).rows[0].target_seq,
        0,
      );
      assert.equal(
        (await client.query("SELECT text FROM items WHERE session_id='z' AND seq=0")).rows[0].text,
        "newer first",
      );
      await resumed.verify();
      await client.query("UPDATE session_entries SET payload=payload WHERE session_id='late'");
      await writer.query("BEGIN");
      await writer.query("DELETE FROM sessions WHERE id='late'");
      await assert.rejects(resumed.catchupBatch(), (error) => (error as { code?: string }).code === "55P03");
      await writer.query("COMMIT");
      while (await resumed.catchupBatch()) continue;
      await resumed.verify();
      await assert.rejects(resumed.cleanup(), /cutover migration/);
      await assert.rejects(resumed.finish(false), /writers-stopped/);
      await client.query(
        "INSERT INTO session_leases(session_id,token,expires_at) VALUES('z','busy',9223372036854775807)",
      );
      await assert.rejects(resumed.finish(true), /active session leases/);
      await client.query("DELETE FROM session_leases WHERE session_id='z'");
      await client.query("ALTER TABLE session_entries DISABLE TRIGGER items_copy_capture");
      await assert.rejects(resumed.catchupBatch(), /capture is missing or disabled/);
      await client.query("ALTER TABLE session_entries ENABLE TRIGGER items_copy_capture");
      await resumed.verify();
      await assert.rejects(resumed.finish(true), /build the items indexes/);
      await assert.rejects(
        client.query("CREATE UNIQUE INDEX CONCURRENTLY items_one_call_per_kind ON items(tenant_id)"),
        /could not create unique index/,
      );
      await writer.query("SELECT pg_advisory_lock(hashtext('qm:schema-migrations'))");
      try {
        await resumed.indexes();
        await resumed.indexes();
      } finally {
        await writer.query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))");
      }
      assert.match(
        (await client.query("SELECT pg_get_indexdef('items_one_call_per_kind'::regclass) AS def")).rows[0].def,
        /call_id\) WHERE \(call_id IS NOT NULL\)/,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_index WHERE indrelid='items'::regclass AND NOT indisvalid",
          )
        ).rows[0].n,
        0,
      );
      await resumed.finish(true);
      assert.equal((await resumed.status()).phase, "ready");
      assert.equal(
        (await client.query("SELECT count(*)::int AS n FROM pg_indexes WHERE tablename='items'")).rows[0].n,
        7,
      );
      await resumed.finish(true);
      await applyPgMigrations(pool, registeredPgMigrations(url!));
      await client.query(
        "INSERT INTO qm_schema_migrations(id,checksum) VALUES('sessions/store/0036-items-cutover','test')",
      );
      await assert.rejects(resumed.catchupBatch(), /cutover is already applied/);
      await resumed.cleanup();
      assert.equal((await client.query("SELECT to_regnamespace('items_copy_ops') AS schema")).rows[0].schema, null);
      assert.ok((await client.query("SELECT count(*)::int AS n FROM items")).rows[0].n > 0);
    } finally {
      await writer.end();
      await client.end();
      await pool.end();
    }
  },
);
