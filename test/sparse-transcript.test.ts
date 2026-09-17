import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { applyPgMigrations, registeredPgMigrations } from "../src/persistence/pg-pool.ts";
import { tapeTranscriptEntryRecord, type SessionStore } from "../src/sessions/session-store.ts";
import { createTranscriptSource } from "../src/harness/tape-projection.ts";
import { migrateTranscriptPage, verifyTranscriptAttributes } from "../scripts/lib/transcript-tape-migration.ts";
import { scopeId, type SessionEntry } from "../src/types.ts";

const scope = scopeId("personal", "sparse");
const entries = (sessionId: string): SessionEntry[] =>
  [2, 5, 9].map((seq) => ({
    sessionId,
    seq,
    parentSeq: seq - 1,
    type: "user",
    payload: { text: `sparse row ${seq}` },
    scopeLabel: scope,
    createdAt: seq,
  }));

async function exercise(store: SessionStore, id: string) {
  await store.addParticipant(id, "owner", undefined, { includeHistory: true });
  assert.deepEqual(await store.getEntries(id), entries(id));
  assert.equal(await store.latestEntrySeq(id), 9);
  assert.equal(await store.countEntries(id), 3);
  const source = createTranscriptSource(store);
  assert.deepEqual(await source.forRender(id, { limit: 1 }), { entries: entries(id).slice(-1), earlier: 2 });
  assert.deepEqual(await source.forViewer(id, "owner", { limit: 1 }), { entries: entries(id).slice(-1), earlier: 2 });
  assert.equal((await source.forRender(id)).earlier, 0);
  for (const beforeSeq of [0, 2, 3, 5, 8, 9, 10, 99]) {
    for (const limit of [undefined, 0, 1, 10]) {
      const prefix = entries(id).filter((entry) => entry.seq < beforeSeq);
      let page = prefix;
      if (limit !== undefined) page = limit === 0 ? [] : prefix.slice(-limit);
      const earlier = page.length ? prefix.length - page.length : 0;
      assert.deepEqual(await store.getEntries(id, { beforeSeq, limit }), page);
      assert.deepEqual(await source.forRender(id, { beforeSeq, limit }), { entries: page, earlier });
      assert.deepEqual(await source.forViewer(id, "owner", { beforeSeq, limit }), { entries: page, earlier });
    }
  }
  assert.deepEqual(
    (await store.getEntries(id, { sinceSeq: 4 })).map((e) => e.seq),
    [5, 9],
  );
  assert.equal((await store.searchEntries("owner", "sparse")).length, 3);
  await store.addParticipant(id, "late");
  assert.deepEqual(await store.visibleEntries(id, "late"), []);
  const lease = (await store.acquireLease(id)).lease!;
  const appended = await store.append(lease, { type: "assistant", payload: { text: "continued" }, scopeLabel: scope });
  assert.equal(appended.seq, 10);
  assert.equal(appended.parentSeq, 9);
  assert.deepEqual(await store.visibleEntries(id, "late"), [appended]);
  await store.removeParticipant(id, "late");
  await store.append(lease, { type: "user", payload: { text: "after departure" }, scopeLabel: scope });
  assert.deepEqual(await store.visibleEntries(id, "late"), [appended]);
  assert.deepEqual(await source.forViewer(id, "late", { beforeSeq: 10, limit: 1 }), { entries: [], earlier: 0 });
  assert.deepEqual(await source.forViewer(id, "late", { beforeSeq: 11, limit: 1 }), {
    entries: [appended],
    earlier: 0,
  });
  await store.releaseLease(lease);
  const summary = (await store.scopeSessionSummaries(scope, false)).find((item) => item.id === id)!;
  assert.equal(summary.messages, 5);
  assert.equal(summary.turns, 4);
  const group = (await store.scopeCronGroups(scope, false)).find((item) => item.cronId === "sparse")!;
  assert.equal(group.messages, 5);
  assert.equal(group.turns, 4);
}

test("memory preserves sparse transcript identities, counts and tenure", async () => {
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("cron:sparse:memory", "dm", scope);
  const lease = (await store.acquireLease(session.id)).lease!;
  for (const entry of entries(session.id)) await store.appendTape(lease, tapeTranscriptEntryRecord(entry));
  await store.releaseLease(lease);
  await exercise(store, session.id);
});

test(
  "Postgres sparse backfill qualifies exact identities without inventing missing entries",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `sparse_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: url.toString() });
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      createPostgresSessionStore(url.toString());
      const migrations = registeredPgMigrations(url.toString());
      const authority = migrations.find((m) => m.id === "sessions/store/0018-transcript-authority")!;
      await applyPgMigrations(
        pool,
        migrations.filter((m) => m !== authority),
      );
      await client.query(
        "INSERT INTO sessions(id,type,scope_id,thread_ref,created_at) VALUES('sparse','dm',$1,'cron:sparse:pg',1)",
        [scope],
      );
      for (const entry of entries("sparse"))
        await client.query(
          "INSERT INTO session_entries(session_id,seq,parent_seq,type,payload,scope_label,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            entry.sessionId,
            entry.seq,
            entry.parentSeq,
            entry.type,
            JSON.stringify(entry.payload),
            entry.scopeLabel,
            entry.createdAt,
          ],
        );
      await client.query(
        "INSERT INTO session_entries(session_id,seq,parent_seq,type,payload,scope_label,created_at) VALUES('sparse',-1,NULL,'user','{}',$1,0)",
        [scope],
      );
      await assert.rejects(
        migrateTranscriptPage(client, "sparse", { afterSeq: -1, limit: 1, apply: true }),
        /invalid sequence/,
      );
      assert.equal(
        (await client.query("SELECT count(*)::int AS n FROM session_tape WHERE session_id='sparse'")).rows[0].n,
        0,
      );
      await client.query("DELETE FROM session_entries WHERE session_id='sparse' AND seq=-1");
      for (const [afterSeq, expectedSeq] of [
        [-1, 2],
        [2, 5],
        [5, 9],
      ]) {
        const page = await migrateTranscriptPage(client, "sparse", { afterSeq: afterSeq!, limit: 1, apply: true });
        assert.deepEqual(page, { busy: false, scanned: 1, changed: 1, afterSeq: expectedSeq });
      }
      await client.query("DELETE FROM session_tape WHERE session_id='sparse' AND entry_seq=5");
      await assert.rejects(applyPgMigrations(pool, [authority]), /migration is incomplete/);
      await migrateTranscriptPage(client, "sparse", { afterSeq: 2, limit: 1, apply: true });
      await applyPgMigrations(pool, [authority]);
      const store = createPostgresSessionStore(url.toString());
      await store.getEntries("sparse");
      await client.query("UPDATE sessions SET messages=10,turns=10,last_activity=0 WHERE id='sparse'");
      await exercise(store, "sparse");
      assert.deepEqual(
        (
          await client.query(
            "SELECT seq,parent_seq FROM session_entries WHERE session_id='sparse' AND seq<10 ORDER BY seq",
          )
        ).rows,
        [
          { seq: 2, parent_seq: 1 },
          { seq: 5, parent_seq: 4 },
          { seq: 9, parent_seq: 8 },
        ],
      );
    } finally {
      await client.end();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  "Postgres preserves historical JSON escapes through migration, context and taint clearing",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const schema = `escaped_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: url.toString() });
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const store = createPostgresSessionStore(url.toString());
      const migrations = registeredPgMigrations(url.toString());
      const authority = migrations.find((m) => m.id === "sessions/store/0018-transcript-authority")!;
      await applyPgMigrations(
        pool,
        migrations.filter((m) => m !== authority),
      );
      await client.query(
        "INSERT INTO sessions(id,type,scope_id,thread_ref,created_at) VALUES('escaped','dm',$1,'escaped',1)",
        [scope],
      );
      const payload = { stdout: "before\u0000after", literal: "\\u0000", surrogate: "\ud800", securityTainted: true };
      const raw = JSON.stringify(payload, null, 2);
      await client.query(
        "INSERT INTO session_entries(session_id,seq,parent_seq,type,payload,scope_label,created_at) VALUES('escaped',0,NULL,'tool_result',$1,$2,1)",
        [raw, scope],
      );
      assert.deepEqual(await migrateTranscriptPage(client, "escaped", { afterSeq: -1, limit: 10, apply: true }), {
        busy: false,
        scanned: 1,
        changed: 1,
        afterSeq: 0,
      });
      assert.equal(
        (await client.query("SELECT payload FROM session_transcript_entries WHERE session_id='escaped'")).rows[0]
          .payload,
        raw,
      );
      assert.equal(
        (
          (await migrateTranscriptPage(client, "escaped", { afterSeq: -1, limit: 10, apply: false })) as {
            changed: number;
          }
        ).changed,
        0,
      );
      await client.query(
        "UPDATE session_tape SET payload=jsonb_set(payload::jsonb,'{entry,payloadJson}',to_jsonb($1::text))::text WHERE session_id='escaped'",
        [JSON.stringify(payload)],
      );
      assert.equal(
        (
          (await migrateTranscriptPage(client, "escaped", { afterSeq: -1, limit: 10, apply: true })) as {
            changed: number;
          }
        ).changed,
        1,
      );
      await client.query(
        "UPDATE session_tape SET payload=jsonb_set(payload::jsonb,'{entry,attributes,securityTainted}','false')::text WHERE session_id='escaped'",
      );
      assert.equal(
        (
          (await migrateTranscriptPage(client, "escaped", { afterSeq: -1, limit: 10, apply: false })) as {
            changed: number;
          }
        ).changed,
        1,
      );
      await client.query("BEGIN READ ONLY");
      await assert.rejects(verifyTranscriptAttributes(client), /metadata differs/);
      await client.query("ROLLBACK");
      assert.equal(
        (
          (await migrateTranscriptPage(client, "escaped", { afterSeq: -1, limit: 10, apply: true })) as {
            changed: number;
          }
        ).changed,
        1,
      );
      await client.query(
        "INSERT INTO sessions(id,type,scope_id,thread_ref,created_at) VALUES('null-payload','dm',$1,'null-payload',1)",
        [scope],
      );
      await client.query(
        "INSERT INTO session_entries(session_id,seq,parent_seq,type,payload,scope_label,created_at) VALUES('null-payload',0,NULL,'tool_result',NULL,$1,1)",
        [scope],
      );
      await client.query(
        "INSERT INTO session_tape(session_id,seq,kind,payload,scope_label,entry_seq,created_at) VALUES('null-payload',0,'annotation',$1,$2,0,1)",
        [
          JSON.stringify({
            event: "transcript_entry",
            entry: { type: "tool_result", payload: null, at: 1, parentSeq: null },
          }),
          scope,
        ],
      );
      assert.equal(
        (
          (await migrateTranscriptPage(client, "null-payload", { afterSeq: -1, limit: 10, apply: true })) as {
            changed: number;
          }
        ).changed,
        1,
      );
      assert.equal(
        (await client.query("SELECT payload FROM session_transcript_entries WHERE session_id='null-payload'")).rows[0]
          .payload,
        null,
      );
      await client.query("BEGIN READ ONLY");
      assert.equal(await verifyTranscriptAttributes(client), 2);
      await client.query("COMMIT");
      await applyPgMigrations(pool, [authority]);
      assert.deepEqual((await store.getEntries("escaped"))[0]?.payload, payload);
      const context = await store.getContextWindow("escaped");
      assert.equal(context.hasSecurityTaint, true);
      assert.deepEqual(context.entries[0]?.payload, payload);
      await store.clearSecurityTaint("escaped");
      const cleared = { stdout: payload.stdout, literal: payload.literal, surrogate: payload.surrogate };
      assert.deepEqual((await store.getEntries("escaped"))[0]?.payload, cleared);
      assert.equal((await store.getContextWindow("escaped")).hasSecurityTaint, false);
      const lease = (await store.acquireLease("escaped")).lease!;
      await store.addParticipant("escaped", "reader", undefined, { includeHistory: true });
      const userPayload = {
        text: "continued\u0000 searchable",
        ["bad\u0000key"]: 1,
        ["bad\ud800key"]: 2,
        name: "Operator",
      };
      const next = await store.append(lease, { type: "user", payload: userPayload, scopeLabel: scope });
      assert.equal(next.seq, 1);
      assert.deepEqual(next.payload, userPayload);
      assert.deepEqual((await store.getEntries("escaped"))[1]?.payload, userPayload);
      assert.equal((await store.searchEntries("reader", "searchable")).length, 1);
      assert.equal(await store.lastSearchableEntrySeq("escaped"), 1);
      assert.equal(await store.missingSearchEntries("escaped"), 0);
      assert.equal((await store.lastUserMessages(["escaped"])).get("escaped"), userPayload.text);
      assert.equal((await store.scopeSessionSummaries(scope, false)).find((row) => row.id === "escaped")?.turns, 1);
      await client.query("DELETE FROM session_entry_search WHERE session_id='escaped' AND seq=1");
      assert.equal(await store.missingSearchEntries("escaped"), 1);
      await store.append(lease, {
        type: "system",
        payload: { kind: "context_\u0000summary", throughSeq: 999, text: "not a real summary" },
        scopeLabel: scope,
      });
      assert.equal((await store.getContextWindow("escaped")).entries.length, 3);
      const keyedPayload = { text: "keyonly searchable", ["bad\u0000key"]: 1, ["bad\ud800key"]: 2 };
      await store.append(lease, { type: "user", payload: keyedPayload, scopeLabel: scope });
      assert.equal((await store.searchEntries("reader", "keyonly")).length, 1);
      assert.equal(await store.lastSearchableEntrySeq("escaped"), 3);
      for (const [seq, oldPayload, type] of [
        [4, ["securityTainted"], "tool_result"],
        [5, "securityTainted", "tool_result"],
        [6, { text: "legacy searchable", searchText: "" }, "user"],
      ] as const)
        await store.appendTape(lease, {
          kind: "annotation",
          payload: { event: "transcript_entry", entry: { type, payload: oldPayload, at: 1, parentSeq: seq - 1 } },
          scopeLabel: scope,
          entrySeq: seq,
        });
      await store.clearSecurityTaint("escaped");
      assert.deepEqual(
        (await store.getEntries("escaped", { sinceSeq: 4 })).slice(0, 2).map((entry) => entry.payload),
        [["securityTainted"], "securityTainted"],
      );
      assert.equal((await store.searchEntries("reader", "legacy")).length, 1);
      assert.equal(await store.lastSearchableEntrySeq("escaped"), 6);
      await client.query("DELETE FROM session_entry_search WHERE session_id='escaped' AND seq=6");
      assert.equal(await store.missingSearchEntries("escaped"), 2);
      await store.releaseLease(lease);
    } finally {
      await client.end();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
