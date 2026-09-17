import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { migrateTranscriptPage } from "../scripts/lib/transcript-tape-migration.ts";
import { createTranscriptSource } from "../src/harness/tape-projection.ts";
import { scopeId } from "../src/types.ts";

const baseUrl = process.env.DATABASE_URL;
const skip = !baseUrl;

async function isolated() {
  const admin = new pg.Pool({ connectionString: baseUrl });
  const schema = `transcript_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(baseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString() });
  return {
    url: url.toString(),
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test(
  "cutover rejects missing, divergent, extra and invalid histories before recording authority",
  { skip },
  async () => {
    const db = await isolated();
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      createPostgresSessionStore(db.url);
      const migrations = registeredPgMigrations(db.url);
      const authority = migrations.find((m) => m.id === "sessions/store/0018-transcript-authority")!;
      await applyPgMigrations(
        db.pool,
        migrations.filter((m) => m !== authority),
      );
      await client.query(
        "INSERT INTO sessions(id,type,scope_id,thread_ref,created_at) VALUES('history','dm','personal:test','history',1)",
      );
      const insertLegacy = async () =>
        client.query(`INSERT INTO session_entries(session_id,seq,parent_seq,type,payload,scope_label,created_at)
      VALUES('history',0,NULL,'user','{"text":"original"}','personal:test',1) ON CONFLICT DO NOTHING`);
      await insertLegacy();
      await client.query(`INSERT INTO session_entries(session_id,seq,parent_seq,type,payload,scope_label,created_at)
      VALUES('history',1,0,'assistant','{"text":"reply"}','personal:test',2)`);
      const reject = async (message = /Transcript migration is incomplete/) => {
        await assert.rejects(applyPgMigrations(db.pool, [authority]), message);
        assert.equal(
          (await client.query("SELECT 1 FROM qm_schema_migrations WHERE id=$1", [authority.id])).rowCount,
          0,
        );
        assert.equal(
          (
            await client.query(
              "SELECT 1 FROM pg_trigger WHERE tgrelid='session_tape'::regclass AND tgname='session_transcript_search_write_through'",
            )
          ).rowCount,
          0,
        );
      };
      const repair = () => migrateTranscriptPage(client, "history", { afterSeq: -1, limit: 100, apply: true });
      await reject();
      assert.deepEqual(await repair(), { busy: false, scanned: 2, changed: 2, afterSeq: 1 });
      await client.query("UPDATE session_entries SET payload=$1 WHERE seq=1", [
        JSON.stringify({ text: "revised reply" }),
      ]);
      await reject();
      await repair();
      await client.query("UPDATE session_tape SET entry_seq=3 WHERE entry_seq=0");
      await reject();
      await client.query("UPDATE session_tape SET entry_seq=0 WHERE entry_seq=3");
      await client.query("UPDATE session_entries SET seq=-1 WHERE seq=0");
      await client.query("UPDATE session_tape SET entry_seq=-1 WHERE entry_seq=0");
      await reject();
      await client.query("UPDATE session_entries SET seq=0 WHERE seq=-1");
      await client.query("UPDATE session_tape SET entry_seq=0 WHERE entry_seq=-1");
      await client.query("UPDATE session_entries SET session_id='orphan' WHERE session_id='history' AND seq=0");
      await reject(/orphaned histories/);
      await client.query("UPDATE session_entries SET session_id='history' WHERE session_id='orphan'");
      await client.query("UPDATE session_tape SET session_id='orphan' WHERE session_id='history' AND entry_seq=0");
      await reject(/orphaned histories/);
      await client.query("UPDATE session_tape SET session_id='history' WHERE session_id='orphan'");
      await applyPgMigrations(db.pool, [authority]);
      assert.equal(
        (await client.query("SELECT checksum FROM qm_schema_migrations WHERE id=$1", [authority.id])).rows[0].checksum,
        authority.checksum,
      );
      const applyAfterCutover = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../scripts/migrate-transcript-tape.ts", import.meta.url)), "--apply"],
        {
          env: { ...process.env, DATABASE_URL: db.url },
          encoding: "utf8",
        },
      );
      assert.equal(applyAfterCutover.status, 1);
      assert.match(applyAfterCutover.stderr, /Transcript authority is already established/);
      const store = createPostgresSessionStore(db.url);
      assert.deepEqual(
        (await store.getEntries("history")).map((e) => e.payload),
        [{ text: "original" }, { text: "revised reply" }],
      );
    } finally {
      await client.end();
      await db.close();
    }
  },
);

test(
  "authoritative readers and allocation survive missing legacy rows for a later write-stop rollback",
  { skip },
  async () => {
    const db = await isolated();
    try {
      let now = 1000;
      const store = createPostgresSessionStore(db.url, { now: () => now++ });
      const scope = scopeId("personal", "rollback");
      const session = await store.getOrCreateByThread("rollback", "dm", scope);
      await store.addParticipant(session.id, "rollback", undefined, { includeHistory: true });
      const lease = (await store.acquireLease(session.id)).lease!;
      const first = await store.append(lease, {
        type: "user",
        payload: { text: "original rollback", securityTainted: true },
        scopeLabel: scope,
      });
      const second = await store.append(lease, {
        type: "assistant",
        payload: { text: "durable answer" },
        scopeLabel: scope,
      });
      await db.pool.query("DELETE FROM session_entries WHERE session_id=$1", [session.id]);
      await db.pool.query("UPDATE sessions SET messages=NULL,turns=NULL,last_activity=NULL WHERE id=$1", [session.id]);
      assert.equal(await store.clearSecurityTaint(session.id), true);
      const expected = [{ ...first, payload: { text: "original rollback" } }, second];
      assert.deepEqual(await store.getEntries(session.id), expected);
      assert.deepEqual((await createTranscriptSource(store).forViewer(session.id, "rollback")).entries, expected);
      assert.equal((await store.searchEntries("rollback", "original"))[0]!.seq, 0);
      assert.equal(await store.latestEntrySeq(session.id), 1);
      await store.addParticipant(session.id, "late");
      assert.deepEqual(await store.visibleEntries(session.id, "late"), []);
      const third = await store.append(lease, { type: "user", payload: { text: "continued" }, scopeLabel: scope });
      assert.equal(third.seq, 2);
      assert.equal(third.parentSeq, 1);
      assert.deepEqual(await store.visibleEntries(session.id, "late"), [third]);
      assert.deepEqual(
        (await db.pool.query("SELECT seq FROM session_entries WHERE session_id=$1", [session.id])).rows,
        [],
      );
      const summary = (await store.scopeSessionSummaries(scope, false))[0]!;
      assert.equal(summary.messages, 3);
      assert.equal(summary.turns, 2);
      assert.equal(
        (await store.attributedTurns())
          .filter((t) => t.sessionId === session.id && t.principalId === "rollback")
          .reduce((sum, t) => sum + t.turns, 0),
        2,
      );
      await store.releaseLease(lease);
      const restarted = createPostgresSessionStore(db.url);
      assert.deepEqual(await restarted.getEntries(session.id), [...expected, third]);
    } finally {
      await db.close();
    }
  },
);

test("normal writes and taint release leave the frozen legacy table untouched", { skip }, async () => {
  const db = await isolated();
  try {
    const store = createPostgresSessionStore(db.url);
    const scope = scopeId("personal", "frozen");
    const session = await store.getOrCreateByThread("frozen", "dm", scope);
    const lease = (await store.acquireLease(session.id)).lease!;
    const original = await store.append(lease, {
      type: "user",
      payload: { text: "frozen history", securityTainted: true },
      scopeLabel: scope,
    });
    await db.pool.query(
      "INSERT INTO session_entries(session_id,seq,parent_seq,type,payload,scope_label,created_at) SELECT session_id,seq,parent_seq,type,payload,scope_label,created_at FROM session_transcript_entries WHERE session_id=$1",
      [session.id],
    );
    const before = (await db.pool.query("SELECT * FROM session_entries")).rows;
    await db.pool
      .query(`CREATE FUNCTION reject_legacy_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'legacy is frozen'; END $$;
      CREATE TRIGGER reject_legacy_write BEFORE INSERT OR UPDATE ON session_entries FOR EACH ROW EXECUTE FUNCTION reject_legacy_write()`);
    assert.equal(await store.clearSecurityTaint(session.id), true);
    const next = await store.append(lease, { type: "assistant", payload: { text: "tape only" }, scopeLabel: scope });
    assert.equal(next.seq, 1);
    assert.deepEqual(await store.getEntries(session.id), [{ ...original, payload: { text: "frozen history" } }, next]);
    assert.deepEqual((await db.pool.query("SELECT * FROM session_entries")).rows, before);
    await store.releaseLease(lease);
  } finally {
    await db.close();
  }
});
