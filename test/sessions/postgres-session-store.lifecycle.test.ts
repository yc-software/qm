import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { scopeId } from "../../src/types.ts";

const URL = process.env.DATABASE_URL!;

test("pg session store: a bare failed acquire means the session is gone, not a lease race", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "U1");
  const missing = await s.acquireLease("00000000-0000-0000-0000-00000000dead", "turn");
  assert.equal(missing.lease, null);
  assert.equal(missing.heldUntil, undefined, "no phantom holder is invented for a deleted session");

  const session = await s.getOrCreateByThread("release-race", "dm", scope);
  const { lease } = await s.acquireLease(session.id, "turn");
  assert.ok(lease);
  const peeked = await s.peekLease(session.id);
  assert.equal(peeked?.holder, "turn");
  await s.releaseLease(lease!);
  assert.equal(await s.peekLease(session.id), null);
  const reacquired = await s.acquireLease(session.id, "turn");
  assert.ok(reacquired.lease, "a released lease is immediately reacquirable");
  await s.releaseLease(reacquired.lease!);
});

test("pg session store: one-per-thread, TTL/fenced lease, monotonic log, visibility window", async () => {
  let now = Date.now();
  const s = createPostgresSessionStore(URL, { leaseTtlMs: 50, now: () => now });
  const scope = scopeId("personal", "U1");

  const a = await s.getOrCreateByThread("t1", "dm", scope);
  const b = await s.getOrCreateByThread("t1", "dm", scope);
  assert.equal(a.id, b.id, "one session per thread");

  await s.recordLlmRequest(a.id, {
    turnSeq: 0,
    step: 0,
    model: "claude-x",
    scopeLabel: scope,
  });
  await s.recordLlmRequest(a.id, {
    turnSeq: 0,
    step: 1,
    model: "claude-x",
    scopeLabel: scope,
    ttftMs: 1200,
    durationMs: 8400,
    usage: { input: 30, output: 120, cacheRead: 5000, cacheWrite: 0, totalTokens: 5150, costUsd: 0.0123 },
  });
  const reqs = await s.listLlmRequests(a.id);
  assert.equal(reqs[0]!.ttftMs, null, "absent per-call timing reads back null");
  assert.equal(reqs[0]!.usage, null, "absent usage reads back null");
  assert.equal(reqs[1]!.ttftMs, 1200, "captured TTFT round-trips");
  assert.equal(reqs[1]!.durationMs, 8400, "captured duration round-trips");
  assert.deepEqual(
    reqs[1]!.usage,
    { input: 30, output: 120, cacheRead: 5000, cacheWrite: 0, totalTokens: 5150, costUsd: 0.0123 },
    "usage round-trips",
  );

  await s.recordLlmRequest(a.id, {
    turnSeq: null,
    step: 0,
    model: "claude-x",
    scopeLabel: scope,
  });
  assert.deepEqual(
    (await s.listLlmRequests(a.id, { orphans: true })).map((r) => r.turnSeq),
    [null],
    "orphans → null-turn rows only",
  );
  const union = await s.listLlmRequests(a.id, { turnSeqs: [0], orphans: true });
  assert.equal(union.filter((r) => r.turnSeq === 0).length, 2, "turnSeqs + orphans keeps the turn rows");
  assert.equal(union.filter((r) => r.turnSeq === null).length, 1, "…and unions in the orphan");

  const { lease: dead } = await s.acquireLease(a.id, "compaction");
  assert.ok(dead);
  const blocked = await s.acquireLease(a.id, "turn");
  assert.equal(blocked.lease, null, "live lease blocks a second writer");
  assert.equal(blocked.heldBy, "compaction", "the blocked writer learns what kind of work holds the lock");
  assert.equal(blocked.heldUntil! - blocked.heldSince!, 50, "…when it was taken, and when it lapses (one TTL)");

  const e0 = await s.append(dead!, { kind: "UserMessage", text: "hi" });
  const e1 = await s.append(dead!, { kind: "AgentMessage", text: "yo" });
  assert.deepEqual([e0.seq, e1.seq], [0, 1], "monotonic seq");
  assert.deepEqual(
    (await s.getItems(a.id)).map((e) => e.kind),
    ["UserMessage", "AgentMessage"],
  );
  assert.equal((await s.getItems(a.id, { limit: 1 }))[0]!.seq, 1, "limit returns the most recent");
  assert.equal((await s.getItem(a.id, 0))!.kind, "UserMessage", "point fetch returns exactly the requested seq");
  assert.equal((await s.getItem(a.id, 1))!.seq, 1);
  assert.equal(await s.getItem(a.id, 99), undefined, "a missing seq is undefined");
  assert.equal(await s.getItem("nope", 0), undefined, "an unknown session is undefined");

  now += 70;
  assert.equal(await s.renewLease(dead!), false, "an expired lease cannot be revived by its old holder");
  const { lease: fresh } = await s.acquireLease(a.id);
  assert.ok(fresh, "expired lease is reclaimable");
  assert.equal(await s.renewLease(fresh!), true, "the live holder renews without writing an entry");
  assert.equal(await s.renewLease(dead!), false, "the superseded holder cannot renew the new lock");
  await assert.rejects(s.append(dead!, { kind: "UserMessage" }), /valid session lease/);

  await s.addParticipant(a.id, "U1");
  assert.equal((await s.visibleItems(a.id, "U1")).length, 0, "a late joiner sees none of the pre-tenure backlog");
  await s.append(fresh!, { kind: "UserMessage", text: "after-join" });
  const seen = await s.visibleItems(a.id, "U1");
  assert.deepEqual(
    seen.map((e) => e.text),
    ["after-join"],
    "only entries from the member's tenure are visible",
  );
  assert.equal((await s.listByParticipant("U1")).find((x) => x.id === a.id)?.hasEntries, true);
  assert.ok(await s.get(a.id));

  assert.equal((await s.getByThread("t1"))?.id, a.id);
  assert.equal(await s.getByThread("never-written"), null, "missing thread → null, no session created");

  assert.equal((await s.acquireLease(a.id)).lease, null, "lease still held by `fresh`");
  await s.forceReleaseLease(a.id);
  const { lease: reacquired } = await s.acquireLease(a.id);
  assert.ok(reacquired, "force-released lease can be re-acquired");
  await assert.rejects(s.append(fresh!, { kind: "UserMessage" }), /valid session lease/);

  now += 5;
  await s.removeParticipant(a.id, "U1");
  await s.addParticipant(a.id, "U1");
  assert.equal(
    (await s.listByParticipant("U1")).find((x) => x.id === a.id)?.hasEntries,
    false,
    "old entries fall outside the new tenure",
  );
  now += 5;
  await s.append(reacquired!, { kind: "UserMessage", text: "re-joined" });
  assert.equal(
    (await s.listByParticipant("U1")).find((x) => x.id === a.id)?.hasEntries,
    true,
    "an entry inside the new tenure counts",
  );
});

test("pg lease: a lock taken by an older instance still blocks, and reports what it can", async () => {
  const s = createPostgresSessionStore(URL, { leaseTtlMs: 60_000 });
  const scope = scopeId("personal", "legacy-lease");
  const session = await s.getOrCreateByThread("legacy-lease", "dm", scope);
  assert.ok((await s.acquireLease(session.id, "turn")).lease);

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query("UPDATE session_leases SET holder = NULL, acquired_at = NULL WHERE session_id = $1", [session.id]);
  } finally {
    await raw.end();
  }

  const blocked = await s.acquireLease(session.id, "turn");
  assert.equal(blocked.lease, null, "a pre-column lock still blocks");
  assert.equal(blocked.heldBy, undefined, "…and says so rather than inventing a holder");
  assert.equal(blocked.heldSince, undefined);
  assert.ok(blocked.heldUntil! > Date.now(), "the expiry is still readable, so the lock is still datable");
});

test("pg deleteSession: hard-removes the session and its rows, leaves others", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "DEL1");
  const a = await s.getOrCreateByThread("del-t1", "dm", scope);
  const keep = await s.getOrCreateByThread("del-t2", "dm", scope);
  await s.addParticipant(a.id, "DEL1");
  await s.addParticipant(keep.id, "DEL1");
  const { lease } = await s.acquireLease(a.id);
  await s.append(lease!, { kind: "UserMessage", text: "hi" });
  await s.recordLlmRequest(a.id, {
    turnSeq: 0,
    step: 0,
    model: "claude-x",
    scopeLabel: scope,
  });

  await s.deleteSession(a.id);

  assert.equal(await s.get(a.id), null, "session row gone");
  assert.equal(await s.getByThread("del-t1"), null, "thread index gone");
  assert.equal((await s.getItems(a.id)).length, 0, "entries gone");
  assert.equal((await s.listLlmRequests(a.id)).length, 0, "llm requests gone");
  assert.equal(
    (await s.listByParticipant("DEL1")).some((x) => x.id === a.id),
    false,
    "dropped from the user's list",
  );
  const keptRow = (await s.listByParticipant("DEL1")).find((x) => x.id === keep.id);
  assert.ok(keptRow, "other sessions untouched");
  assert.equal(keptRow!.hasEntries, false, "an entry-less session reads back hasEntries=false");
  assert.equal((await s.acquireLease(a.id)).lease, null, "no lease is granted on a deleted session");
  const reborn = await s.getOrCreateByThread("del-t1", "dm", scope);
  assert.notEqual(reborn.id, a.id, "the thread gets a fresh session");
  assert.notEqual((await s.acquireLease(reborn.id)).lease, null, "the fresh session is leasable");
});

test("pg store startup never rewrites or waits on session rows", async () => {
  const nowRef = { v: Date.now() - 60_000 };
  const s = createPostgresSessionStore(URL, { now: () => nowRef.v });
  const scope = scopeId("channel", "boot-no-lock");
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await s.getOrCreateByThread(`bootNoLock${i}`, "channel", scope)).id);
  nowRef.v += 10_000;
  for (const id of ids) {
    const { lease } = await s.acquireLease(id);
    await s.append(lease!, { kind: "UserMessage", text: "hi" });
    await s.releaseLease(lease!);
  }
  const [held, writing, ...idle] = ids as [string, string, ...string[]];
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const holder = await raw.connect();
  let open = false;
  const within = <T>(p: Promise<T>, what: string): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} blocked`)), 5_000).unref()),
    ]);
  try {
    const rowVersions = async () =>
      (await raw.query("SELECT id, xmin::text AS v FROM sessions WHERE id = ANY($1) ORDER BY id", [idle])).rows;
    const before = await rowVersions();
    await holder.query("BEGIN");
    open = true;
    await holder.query("SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE", [held]);

    const boots = [0, 1, 2].map(() => createPostgresSessionStore(URL));
    await within(Promise.all(boots.map((b) => b.get(held))), "concurrent fresh-store startup");
    const { lease } = await boots[0]!.acquireLease(writing);
    await within(
      boots[0]!.append(lease!, { kind: "AgentMessage", text: "beside a boot" }),
      "append on a freshly booted store",
    );
    await boots[0]!.releaseLease(lease!);
    assert.deepEqual(await rowVersions(), before, "startup writes no session rows");
    const row = (await boots[1]!.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === writing)!;
    assert.equal(row.messages, 2, "normal appends keep exact counters");
    assert.equal(row.turns, 1);
  } finally {
    if (open) await holder.query("ROLLBACK");
    holder.release();
    await raw.end();
  }
});

test("pg null-byte payloads: stripped on write and counted alongside raw items", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("channel", "nul");
  const a = await s.getOrCreateByThread("nulA", "channel", scope);
  await s.addParticipant(a.id, "NUL1");
  const { lease } = await s.acquireLease(a.id);
  const e = await s.append(lease!, { kind: "UserMessage", text: "a\u0000b" });
  await s.releaseLease(lease!);
  assert.equal(e.text, "ab", "append returns the sanitized text, matching what is stored");
  assert.equal((await s.getItems(a.id))[0]!.text, "ab", "null byte stripped at write");

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query(
      "INSERT INTO items(tenant_id, session_id, seq, kind, body, created_at) VALUES (qm_tenant_id(),$1,$2,'UserMessage',$3,to_timestamp($4 / 1000.0))",
      [a.id, 1, { text: "xy" }, Date.now()],
    );
    await raw.query("UPDATE sessions SET messages = NULL, turns = NULL, last_activity = NULL WHERE id = $1", [a.id]);
  } finally {
    await raw.end();
  }
  const attributed = (await s.attributedTurns()).filter((t) => t.sessionId === a.id);
  assert.equal(
    attributed.reduce((n, t) => n + t.turns, 0),
    2,
    "both user turns counted",
  );
  const { lease: lease2 } = await s.acquireLease(a.id);
  await s.append(lease2!, { kind: "UserMessage", text: "z" });
  await s.releaseLease(lease2!);
  const row = (await s.scopeSessionSummaries(scope, false, { limit: 500 })).find((r) => r.id === a.id)!;
  assert.equal(row.turns, 3, "append recounts NULL turns");
  assert.equal(row.messages, 3, "messages self-heal from the entry seq");
});

test("pg deleteSessionIfEmpty: an expired lease forfeits, and the stale holder cannot orphan entries", async () => {
  let now = Date.now();
  const s = createPostgresSessionStore(URL, { leaseTtlMs: 40, now: () => now });
  const scope = scopeId("personal", "USTALE");
  const sess = await s.getOrCreateByThread("web:USTALE:seed", "dm", scope);
  const att = await s.acquireLease(sess.id);
  assert.ok(att.lease);
  now += 60;
  assert.equal(await s.deleteSessionIfEmpty(sess.id), true, "an expired lease does not block the discard");
  assert.equal(await s.get(sess.id), null);
  await assert.rejects(
    s.append(att.lease!, { kind: "UserMessage" }),
    /valid session lease/,
    "the stale holder cannot append after the discard",
  );
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const leftovers = await raw.query(
    "SELECT (SELECT COUNT(*) FROM items WHERE session_id = $1) AS e, (SELECT COUNT(*) FROM session_leases WHERE session_id = $1) AS l",
    [sess.id],
  );
  await raw.end();
  assert.equal(Number(leftovers.rows[0].e), 0, "no orphaned entries after the stale append is refused");
  assert.equal(Number(leftovers.rows[0].l), 0, "no orphaned lease row survives");
});

test("pg deleteSession: racing a fresh lease acquisition never orphans entries", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "UHARD");
  for (let i = 0; i < 15; i++) {
    const sess = await s.getOrCreateByThread(`web:UHARD:${i}`, "dm", scope);
    const [attempt] = await Promise.all([s.acquireLease(sess.id), s.deleteSession(sess.id)]);
    assert.equal(await s.get(sess.id), null, "the session is gone either way");
    if (attempt.lease) {
      await assert.rejects(
        s.append(attempt.lease, { kind: "UserMessage" }),
        /valid session lease/,
        "a lease granted before the delete cannot orphan entries",
      );
    }
  }
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const leftovers = await raw.query(
    "SELECT COUNT(*) AS n FROM session_leases l WHERE NOT EXISTS (SELECT 1 FROM sessions ss WHERE ss.id = l.session_id)",
  );
  await raw.end();
  assert.equal(Number(leftovers.rows[0].n), 0, "no lease row survives its session");
});

test("pg deleteSessionIfEmpty: racing a fresh lease acquisition never orphans the lease", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "URACE");
  for (let i = 0; i < 15; i++) {
    const sess = await s.getOrCreateByThread(`web:URACE:${i}`, "dm", scope);
    const [attempt, discarded] = await Promise.all([s.acquireLease(sess.id), s.deleteSessionIfEmpty(sess.id)]);
    if (discarded) {
      assert.equal(attempt.lease, null, "a discarded session never grants a lease");
      assert.equal(await s.get(sess.id), null);
    } else {
      assert.ok(attempt.lease, "when the discard is refused the lease was granted");
      assert.ok(await s.get(sess.id), "the session survives when the lease won");
      await s.releaseLease(attempt.lease!);
      assert.equal(await s.deleteSessionIfEmpty(sess.id), true);
    }
  }
});

test("pg deleteSessionIfEmpty: a held lease or landed entries refuse the discard atomically", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "UDISC");
  const sess = await s.getOrCreateByThread("web:UDISC:seed", "dm", scope);
  const att = await s.acquireLease(sess.id);
  assert.ok(att.lease);
  assert.equal(await s.deleteSessionIfEmpty(sess.id), false, "a held lease blocks the discard");
  await s.append(att.lease, { kind: "UserMessage", text: "seed" });
  await s.releaseLease(att.lease);
  assert.equal(await s.deleteSessionIfEmpty(sess.id), false, "entries block the discard");
  assert.ok(await s.get(sess.id), "the refused discard leaves the session intact");

  const empty = await s.getOrCreateByThread("web:UDISC:seed2", "dm", scope);
  const att2 = await s.acquireLease(empty.id);
  assert.ok(att2.lease);
  await s.releaseLease(att2.lease);
  assert.equal(await s.deleteSessionIfEmpty(empty.id), true, "a released empty session is discarded");
  assert.equal(await s.get(empty.id), null);

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  const orphans = await raw.query(
    "SELECT (SELECT COUNT(*) FROM items WHERE session_id = $1) AS e, (SELECT COUNT(*) FROM session_leases WHERE session_id = $1) AS l",
    [empty.id],
  );
  await raw.end();
  assert.equal(Number(orphans.rows[0].e), 0, "no orphaned entries survive the discard");
  assert.equal(Number(orphans.rows[0].l), 0, "no orphaned lease survives the discard");
});

test("pg transcript write failure rolls back the entry and its counters", async () => {
  const s = createPostgresSessionStore(URL);
  const scope = scopeId("personal", "canonical-failure");
  const session = await s.getOrCreateByThread("pg-canonical-failure", "dm", scope);
  const { lease } = await s.acquireLease(session.id);
  assert.ok(lease);
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  await client.query(
    `CREATE FUNCTION reject_transcript_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'transcript unavailable'; END $$`,
  );
  await client.query(
    `CREATE TRIGGER reject_transcript_test BEFORE INSERT ON items FOR EACH ROW WHEN (NEW.session_id = '${session.id}') EXECUTE FUNCTION reject_transcript_test()`,
  );
  try {
    await assert.rejects(s.append(lease, { kind: "UserMessage", text: "must rollback" }), /transcript unavailable/);
    assert.deepEqual(await s.getItems(session.id), []);
    assert.equal(await s.latestItemSeq(session.id), -1);
    const counters = (await client.query("SELECT messages FROM sessions WHERE id=$1", [session.id])).rows[0];
    assert.equal(counters.messages, 0);
  } finally {
    await client.query("DROP TRIGGER reject_transcript_test ON items");
    await client.query("DROP FUNCTION reject_transcript_test()");
    await client.end();
    await s.releaseLease(lease);
  }
});
