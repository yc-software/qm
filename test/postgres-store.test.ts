import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore, rowToSession } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { scopeId, type Principal, type TurnResult } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres store tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS sessions, session_entries, participants, session_leases, session_tape, session_llm_requests, runs, tool_calls CASCADE",
  );
  await p.end();
});

const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (text: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: "t", audience: [actor] },
  origin: { kind: "direct" },
  text,
});

test("pg session row mapping ignores incomplete fork provenance", () => {
  const session = rowToSession({
    id: "fork",
    type: "dm",
    scope_id: "personal:U1",
    thread_ref: "thread",
    created_at: 1,
    forked_from_session_id: "source",
    fork_boundary_seq: null,
  });
  assert.equal(session.forkedFrom, undefined);
  assert.equal(session.forkBoundarySeq, undefined);
});

test("pg session store: fork provenance survives a store restart", { skip }, async () => {
  const first = createPostgresSessionStore(URL!);
  const session = await first.getOrCreateByThread("fork-provenance", "dm", scopeId("personal", "U1"));
  await first.updateForkProvenance(session.id, {
    forkedFrom: { sessionId: "source-session", title: "Original" },
    forkBoundarySeq: 4,
  });
  const restarted = createPostgresSessionStore(URL!);
  const loaded = await restarted.get(session.id);
  assert.deepEqual(loaded?.forkedFrom, { sessionId: "source-session", title: "Original" });
  assert.equal(loaded?.forkBoundarySeq, 4);
});

test("pg session store: one-per-thread, TTL/fenced lease, monotonic log, visibility window", { skip }, async () => {
  const s = createPostgresSessionStore(URL!, { leaseTtlMs: 50 });
  const scope = scopeId("personal", "U1");

  const a = await s.getOrCreateByThread("t1", "dm", scope);
  const b = await s.getOrCreateByThread("t1", "dm", scope);
  assert.equal(a.id, b.id, "one session per thread");

  await s.recordLlmRequest(a.id, {
    turnSeq: 0,
    step: 0,
    model: "claude-x",
    scopeLabel: scope,
    request: { messages: [] },
  });
  await s.recordLlmRequest(a.id, {
    turnSeq: 0,
    step: 1,
    model: "claude-x",
    scopeLabel: scope,
    request: { messages: [] },
    truncated: true,
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

  const metaOnly = await s.listLlmRequests(a.id, { omitRequest: true });
  assert.equal(metaOnly.length, 2, "every row still listed");
  assert.ok(
    metaOnly.every((r) => r.request === null),
    "bodies omitted from the projection",
  );
  assert.equal(metaOnly[1]!.ttftMs, 1200, "metadata (timing) still selected");
  await s.recordLlmRequest(a.id, {
    turnSeq: null,
    step: 0,
    model: "claude-x",
    scopeLabel: scope,
    request: { messages: [] },
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

  const e0 = await s.append(dead!, { type: "user", payload: { text: "hi" }, scopeLabel: scope });
  const e1 = await s.append(dead!, { type: "assistant", payload: { text: "yo" }, scopeLabel: scope });
  assert.deepEqual([e0.seq, e1.seq], [0, 1], "monotonic seq");
  assert.deepEqual(
    (await s.getEntries(a.id)).map((e) => e.type),
    ["user", "assistant"],
  );
  assert.equal((await s.getEntries(a.id, { limit: 1 }))[0]!.seq, 1, "limit returns the most recent");

  await new Promise((r) => setTimeout(r, 70));
  const { lease: fresh } = await s.acquireLease(a.id);
  assert.ok(fresh, "expired lease is reclaimable");
  await assert.rejects(s.append(dead!, { type: "user", payload: {}, scopeLabel: scope }), /valid session lease/);

  await s.addParticipant(a.id, "U1");
  assert.equal((await s.visibleEntries(a.id, "U1")).length, 0, "a late joiner sees none of the pre-tenure backlog");
  await s.append(fresh!, { type: "user", payload: { text: "after-join" }, scopeLabel: scope });
  const seen = await s.visibleEntries(a.id, "U1");
  assert.deepEqual(
    seen.map((e) => (e.payload as { text?: string }).text),
    ["after-join"],
    "only entries from the member's tenure are visible",
  );
  assert.equal((await s.listByParticipant("U1")).find((x) => x.id === a.id)?.hasEntries, true);
  assert.equal(
    (await s.listAll()).some((x) => x.id === a.id),
    true,
  );

  assert.equal((await s.getByThread("t1"))?.id, a.id);
  assert.equal(await s.getByThread("never-written"), null, "missing thread → null, no session created");

  assert.equal((await s.acquireLease(a.id)).lease, null, "lease still held by `fresh`");
  await s.forceReleaseLease(a.id);
  const { lease: reacquired } = await s.acquireLease(a.id);
  assert.ok(reacquired, "force-released lease can be re-acquired");
  await assert.rejects(s.append(fresh!, { type: "user", payload: {}, scopeLabel: scope }), /valid session lease/);

  await new Promise((r) => setTimeout(r, 5));
  await s.removeParticipant(a.id, "U1");
  await s.addParticipant(a.id, "U1");
  assert.equal(
    (await s.listByParticipant("U1")).find((x) => x.id === a.id)?.hasEntries,
    false,
    "old entries fall outside the new tenure",
  );
  await new Promise((r) => setTimeout(r, 5));
  await s.append(reacquired!, { type: "user", payload: { text: "re-joined" }, scopeLabel: scope });
  assert.equal(
    (await s.listByParticipant("U1")).find((x) => x.id === a.id)?.hasEntries,
    true,
    "an entry inside the new tenure counts",
  );
});

test("pg lease: a lock taken by an older instance still blocks, and reports what it can", { skip }, async () => {
  const s = createPostgresSessionStore(URL!, { leaseTtlMs: 60_000 });
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

test("pg tape coverage counts only boolean turn-end watermarks and legacy imports", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const scope = scopeId("personal", "tape-coverage");
  const session = await s.getOrCreateByThread("pg-tape-coverage", "dm", scope);
  const { lease } = await s.acquireLease(session.id);
  assert.ok(lease);

  await s.appendTape(lease, { kind: "annotation", payload: { subturnEnd: true }, scopeLabel: scope, entrySeq: 50 });
  await s.appendTape(lease, { kind: "annotation", payload: { turnEnd: "true" }, scopeLabel: scope, entrySeq: 49 });
  await s.appendTape(lease, {
    kind: "context_event",
    payload: { event: "compaction", text: "summary" },
    scopeLabel: scope,
    coversEntrySeq: 60,
  });
  await s.appendTape(lease, {
    kind: "message",
    harness: "pi",
    payload: { role: "user", content: [{ type: "text", text: "\ud800" }] },
    scopeLabel: scope,
  });
  assert.equal(await s.tapeCoverage(session.id), -1);

  await s.appendTape(lease, { kind: "annotation", payload: { turnEnd: true }, scopeLabel: scope, entrySeq: 42 });
  assert.equal(await s.tapeCoverage(session.id), 42);
  await s.appendTape(lease, {
    kind: "context_event",
    payload: { event: "legacy_import", messages: [] },
    scopeLabel: scope,
    coversEntrySeq: 45,
  });
  assert.equal(await s.tapeCoverage(session.id), 45);
});

test("pg participant tenure remains exact when every event shares a timestamp", { skip }, async () => {
  const at = Date.now() + 1_000_000;
  const s = createPostgresSessionStore(URL!, { now: () => at });
  const scope = scopeId("personal", "SAME-TICK");
  const session = await s.getOrCreateByThread("same-tick-window", "dm", scope);
  const { lease } = await s.acquireLease(session.id);
  assert.ok(lease);
  await s.append(lease!, { type: "user", payload: { text: "before" }, scopeLabel: scope });
  await s.addParticipant(session.id, "SAME-TICK");
  assert.deepEqual(await s.visibleEntries(session.id, "SAME-TICK"), []);
  await s.append(lease!, { type: "user", payload: { text: "during" }, scopeLabel: scope });
  assert.deepEqual(
    (await s.visibleEntries(session.id, "SAME-TICK")).map((entry) => entry.seq),
    [1],
  );
  await s.removeParticipant(session.id, "SAME-TICK");
  await s.append(lease!, { type: "user", payload: { text: "gap" }, scopeLabel: scope });
  await s.addParticipant(session.id, "SAME-TICK");
  assert.deepEqual(await s.visibleEntries(session.id, "SAME-TICK"), []);
  await s.append(lease!, { type: "user", payload: { text: "after" }, scopeLabel: scope });
  assert.deepEqual(
    (await s.visibleEntries(session.id, "SAME-TICK")).map((entry) => entry.seq),
    [3],
  );
});

test("pg deleteSession: hard-removes the session and its rows, leaves others", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const scope = scopeId("personal", "DEL1");
  const a = await s.getOrCreateByThread("del-t1", "dm", scope);
  const keep = await s.getOrCreateByThread("del-t2", "dm", scope);
  await s.addParticipant(a.id, "DEL1");
  await s.addParticipant(keep.id, "DEL1");
  const { lease } = await s.acquireLease(a.id);
  await s.append(lease!, { type: "user", payload: { text: "hi" }, scopeLabel: scope });
  await s.recordLlmRequest(a.id, {
    turnSeq: 0,
    step: 0,
    model: "claude-x",
    scopeLabel: scope,
    request: { messages: [] },
  });

  await s.deleteSession(a.id);

  assert.equal(await s.get(a.id), null, "session row gone");
  assert.equal(await s.getByThread("del-t1"), null, "thread index gone");
  assert.equal((await s.getEntries(a.id)).length, 0, "entries gone");
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

test("pg scopeSessionSummaries: counts via aggregate, not per-transcript reads", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const team = scopeId("channel", "team-eng");
  const other = scopeId("channel", "team-sales");

  const a = await s.getOrCreateByThread("sumA", "channel", team);
  const b = await s.getOrCreateByThread("sumB", "channel", team);
  const c = await s.getOrCreateByThread("sumC", "channel", other);
  const { lease } = await s.acquireLease(a.id);
  await s.append(lease!, { type: "user", payload: { text: "1" }, scopeLabel: team });
  await s.append(lease!, { type: "assistant", payload: { text: "ack" }, scopeLabel: team });
  const last = await s.append(lease!, { type: "user", payload: { text: "2" }, scopeLabel: team });

  const cron = await s.getOrCreateByThread("agent:main:cron:c1", "channel", team);
  const webhook = await s.getOrCreateByThread("agent:main:webhook:wh1", "channel", team);

  const scoped = await s.scopeSessionSummaries(team, false);
  assert.deepEqual(
    scoped.map((r) => r.id).sort(),
    [a.id, b.id, cron.id, webhook.id].sort(),
    "scope filter excludes other scopes",
  );
  assert.equal(scoped.find((r) => r.id === a.id)!.origin, "conversation", "real conversation tagged conversation");
  assert.equal(scoped.find((r) => r.id === cron.id)!.origin, "cron", "cron monologue thread tagged cron");
  const ra = scoped.find((r) => r.id === a.id)!;
  assert.equal(ra.turns, 2, "turns = user entries");
  assert.equal(ra.messages, 3, "messages = all entries");
  assert.equal(ra.lastActivity, last.createdAt, "last activity = newest entry");
  assert.equal(ra.firstMessage, "1", "first message = opening user turn (not the assistant reply)");
  assert.equal(ra.lastMessage, "2", "last message = newest user turn");
  const rb = scoped.find((r) => r.id === b.id)!;
  assert.deepEqual([rb.turns, rb.messages], [0, 0], "entry-less session counts zero");
  assert.equal(rb.lastActivity, rb.createdAt, "entry-less last activity falls back to created_at");
  assert.deepEqual([rb.firstMessage, rb.lastMessage], ["", ""], "entry-less session has no message preview");

  const all = await s.scopeSessionSummaries(team, true);
  assert.equal(
    all.some((r) => r.id === c.id),
    true,
    "orgWide includes every scope",
  );

  const light = await s.scopeSessionSummaries(team, false, undefined, false);
  const la = light.find((r) => r.id === a.id)!;
  assert.equal(la.turns, 2, "light rows still carry counts");
  assert.deepEqual([la.firstMessage, la.lastMessage], ["", ""], "light rows omit previews");
  const previews = await s.lastUserMessages([a.id, b.id]);
  assert.equal(previews.get(a.id), "2", "lastUserMessages returns the newest user turn");
  assert.equal(previews.has(b.id), false, "entry-less session absent from the preview map");
  assert.equal((await s.lastUserMessages([])).size, 0, "empty id set → empty map");

  const conversations = await s.scopeSessionSummaries(team, false, { limit: 10, offset: 0, category: "conversation" });
  assert.deepEqual(
    conversations.map((r) => r.id).sort(),
    [a.id, b.id].sort(),
    "conversation page excludes cron monologues before pagination",
  );
  const background = await s.scopeSessionSummaries(team, false, { limit: 10, offset: 0, category: "background" });
  assert.deepEqual(
    background.map((r) => r.id).sort(),
    [cron.id, webhook.id].sort(),
    "background page contains trigger sessions",
  );
  const cronPage = await s.scopeSessionSummaries(team, false, {
    limit: 1,
    offset: 0,
    category: "background",
    origin: "cron",
  });
  assert.deepEqual(
    cronPage.map((r) => r.id),
    [cron.id],
    "origin page filters before pagination",
  );
  const otherPage = await s.scopeSessionSummaries(team, false, {
    limit: 1,
    offset: 0,
    category: "background",
    origin: "other_background",
  });
  assert.deepEqual(
    otherPage.map((r) => r.id),
    [webhook.id],
    "other background page filters before pagination",
  );

  const backgroundStats = await s.scopeSessionStats(team, false, "background", "cron");
  assert.equal(backgroundStats.total, 1);
  assert.equal(backgroundStats.byType.cron, 1);
  assert.deepEqual(backgroundStats.totalByCategory, { conversation: 2, background: 2, all: 4 });
});

test("pg scopeCronGroups: one aggregated row per cron; cronId page filters one cron's fires", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const team = scopeId("channel", "cron-groups");
  const c1a = await s.getOrCreateByThread("cron:g1:slot1", "channel", team);
  const c1b = await s.getOrCreateByThread("cron:g1:slot2", "channel", team);
  const c2 = await s.getOrCreateByThread("agent:main:cron:g2", "channel", team);
  await s.getOrCreateByThread("agent:main:webhook:gwh", "channel", team);
  const { lease } = await s.acquireLease(c1a.id);
  await s.append(lease!, { type: "user", payload: { text: "fire" }, scopeLabel: team });
  await s.append(lease!, { type: "assistant", payload: { text: "done" }, scopeLabel: team });

  const groups = await s.scopeCronGroups(team, false);
  assert.deepEqual(groups.map((g) => g.cronId).sort(), ["g1", "g2"], "one row per cron; webhook excluded");
  const g1 = groups.find((g) => g.cronId === "g1")!;
  assert.deepEqual([g1.sessions, g1.turns, g1.messages], [2, 1, 2]);
  const g2 = groups.find((g) => g.cronId === "g2")!;
  assert.deepEqual([g2.sessions, g2.turns, g2.messages], [1, 0, 0], "entry-less fire still counted");
  assert.equal(g2.lastActivity, c2.createdAt);

  const fresh = await s.getOrCreateByThread("cron:g1:slot3", "channel", team);
  const regrouped = await s.scopeCronGroups(team, false);
  assert.equal(
    regrouped.find((g) => g.cronId === "g1")!.lastActivity,
    fresh.createdAt,
    "a fresh entry-less fire advances the group's last activity past older fires' entries",
  );

  const cronStats = await s.scopeSessionStats(team, false, "background", "cron", "g1");
  assert.equal(cronStats.total, 3, "stats cronId filter counts one cron's fires");

  const fires = await s.scopeSessionSummaries(team, false, { limit: 10, offset: 0, cronId: "g1" });
  assert.deepEqual(
    fires.map((r) => r.id).sort(),
    [c1a.id, c1b.id, fresh.id].sort(),
    "cronId page returns only that cron's fires",
  );
  const page = await s.scopeSessionSummaries(team, false, { limit: 1, offset: 1, cronId: "g1" });
  assert.equal(page.length, 1, "cronId filter applies before pagination");

  const stats = await s.scopeSessionStats(team, false);
  assert.equal(stats.crons, 2, "distinct crons, not fires");
  assert.equal(stats.crons, regrouped.length, "tab count == listable cron rows (one classifier)");
  assert.equal(stats.byType.cron, 4, "byType still counts cron sessions (fires)");
  assert.equal(
    regrouped.reduce((n, g) => n + g.sessions, 0),
    stats.byType.cron,
    "every counted cron session is listed under some cron",
  );
  assert.equal((await s.scopeSessionStats(team, false, "conversation")).crons, 2, "crons ignores the active filter");
});

test("pg scopeSessionSummaries: keyset cursor pages stitch into the offset listing", { skip }, async () => {
  let clock = Date.now() + 1_000_000;
  const s = createPostgresSessionStore(URL!, { now: () => ++clock });
  const scope = scopeId("channel", "keyset");
  for (let i = 0; i < 5; i++) {
    const sess = await s.getOrCreateByThread(`keyset:${i}`, "channel", scope);
    const { lease } = await s.acquireLease(sess.id);
    await s.append(lease!, { type: "user", payload: { text: `m${i}` }, scopeLabel: scope });
    await s.releaseLease(lease!);
  }
  const all = await s.scopeSessionSummaries(scope, false, { limit: 10, offset: 0 });
  const page1 = await s.scopeSessionSummaries(scope, false, { limit: 2, offset: 0 });
  const c1 = page1[page1.length - 1]!;
  const page2 = await s.scopeSessionSummaries(scope, false, {
    limit: 2,
    offset: 0,
    before: { lastActivity: c1.lastActivity, id: c1.id },
  });
  const c2 = page2[page2.length - 1]!;
  const page3 = await s.scopeSessionSummaries(scope, false, {
    limit: 2,
    offset: 0,
    before: { lastActivity: c2.lastActivity, id: c2.id },
  });
  assert.deepEqual(
    [...page1, ...page2, ...page3].map((r) => r.id),
    all.map((r) => r.id),
    "cursor pages stitch into the full newest-first listing",
  );
  assert.equal(page3.length, 1, "final partial page");

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query("UPDATE sessions SET messages = NULL, turns = NULL, last_activity = NULL WHERE id = $1", [
      all[2]!.id,
    ]);
  } finally {
    await raw.end();
  }
  const rerun = await s.scopeSessionSummaries(scope, false, { limit: 10, offset: 0 });
  const p1 = await s.scopeSessionSummaries(scope, false, { limit: 2, offset: 0 });
  const p2 = await s.scopeSessionSummaries(scope, false, {
    limit: 2,
    offset: 0,
    before: { lastActivity: p1[1]!.lastActivity, id: p1[1]!.id },
  });
  const p3 = await s.scopeSessionSummaries(scope, false, {
    limit: 2,
    offset: 0,
    before: { lastActivity: p2[1]!.lastActivity, id: p2[1]!.id },
  });
  assert.deepEqual(
    [...p1, ...p2, ...p3].map((r) => r.id),
    rerun.map((r) => r.id),
    "a NULL-counter row still pages through on its created_at fallback",
  );
  assert.ok(
    rerun.some((r) => r.id === all[2]!.id),
    "the NULL-counter row is present in the listing",
  );
});

test("pg scopeSessionSummaries: previews extracted in SQL match the JS extraction", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const scope = scopeId("channel", "pvw");
  const obj = await s.getOrCreateByThread("pvwA", "channel", scope);
  const { lease } = await s.acquireLease(obj.id);
  await s.append(lease!, {
    type: "user",
    payload: { text: `[${"c".repeat(3000)}]\n\nthe real opener` },
    scopeLabel: scope,
  });
  await s.append(lease!, { type: "user", payload: { text: "x".repeat(300) }, scopeLabel: scope });
  await s.releaseLease(lease!);
  const strp = await s.getOrCreateByThread("pvwB", "channel", scope);
  const { lease: lease2 } = await s.acquireLease(strp.id);
  await s.append(lease2!, { type: "user", payload: "a bare string payload", scopeLabel: scope });
  await s.releaseLease(lease2!);
  const nontext = await s.getOrCreateByThread("pvwC", "channel", scope);
  const { lease: lease3 } = await s.acquireLease(nontext.id);
  await s.append(lease3!, { type: "user", payload: { text: 42 }, scopeLabel: scope });
  await s.releaseLease(lease3!);

  const rows = await s.scopeSessionSummaries(scope, false);
  const ra = rows.find((r) => r.id === obj.id)!;
  assert.equal(
    ra.firstMessage,
    "the real opener",
    "bracketed boilerplate stripped (even a >2KB block), like the JS preview",
  );
  assert.equal(ra.lastMessage, "x".repeat(99) + "…", "last-message preview truncated to 100 like before");
  const rb = rows.find((r) => r.id === strp.id)!;
  assert.equal(rb.firstMessage, "a bare string payload", "a bare-string payload still previews");
  assert.equal(
    rows.find((r) => r.id === nontext.id)!.firstMessage,
    "",
    "a non-string text field has no preview, like the JS path",
  );

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query(
      "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [strp.id, 1, 0, "user", '{"text":"poisoned\\u0000tail"}', scope, Date.now()],
    );
  } finally {
    await raw.end();
  }
  const again = (await s.scopeSessionSummaries(scope, false)).find((r) => r.id === strp.id)!;
  assert.equal(again.lastMessage, "poisonedtail", "the null-byte escape is dropped, not fatal");

  const junk = await s.getOrCreateByThread("pvwD", "channel", scope);
  const pg2 = (await import("pg")).default;
  const raw2 = new pg2.Pool({ connectionString: URL });
  try {
    for (const [seq, bad] of [
      [1, '{"text":"truncated'],
      [2, '"unterminated'],
    ] as const) {
      await raw2.query(
        "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [junk.id, seq, seq - 1, "user", bad, scope, Date.now()],
      );
    }
  } finally {
    await raw2.end();
  }
  const orgWide = await s.scopeSessionSummaries(scope, true);
  assert.equal(
    orgWide.find((r) => r.id === junk.id)!.firstMessage,
    "",
    "a malformed-JSON payload previews as empty, not a fatal cast",
  );
});

test("pg sessions table indexes scoped activity pages", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  await s.listAll();
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const result = await raw.query("SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1::text[])", [
      ["sessions_by_scope", "sessions_by_scope_activity"],
    ]);
    const indexes = new Map(result.rows.map((row) => [row.indexname as string, row.indexdef as string]));
    assert.match(indexes.get("sessions_by_scope") ?? "", /\(scope_id, created_at DESC\)/);
    assert.match(
      indexes.get("sessions_by_scope_activity") ?? "",
      /scope_id, COALESCE\(last_activity, created_at\) DESC, id DESC/,
    );
  } finally {
    await raw.end();
  }
});

test("pg safe JSON functions are marked parallel-unsafe", { skip }, async () => {
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const seed = createPostgresSessionStore(URL!);
    await seed.listAll();
    await raw.query(`CREATE OR REPLACE FUNCTION safe_jsonb(t text) RETURNS jsonb
      LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $safe_jsonb$
      BEGIN RETURN t::jsonb; EXCEPTION WHEN others THEN RETURN NULL; END $safe_jsonb$`);
    await raw.query("CREATE INDEX safe_jsonb_parallel_repair_test ON session_entries ((safe_jsonb(payload) ->> 'ts'))");

    const s = createPostgresSessionStore(URL!);
    await s.listAll();

    const result = await raw.query(
      `SELECT proname, proparallel
         FROM pg_proc
        WHERE oid IN ('safe_json(text)'::regprocedure, 'safe_jsonb(text)'::regprocedure)`,
    );
    assert.deepEqual(
      new Map(result.rows.map((row) => [row.proname as string, row.proparallel as string])),
      new Map([
        ["safe_json", "u"],
        ["safe_jsonb", "u"],
      ]),
    );
    assert.equal(
      (await raw.query("SELECT to_regclass('safe_jsonb_parallel_repair_test') AS index")).rows[0]!.index,
      "safe_jsonb_parallel_repair_test",
    );
  } finally {
    await raw.query("DROP INDEX IF EXISTS safe_jsonb_parallel_repair_test");
    await raw.query("DROP FUNCTION IF EXISTS safe_jsonb(text)");
    await raw.end();
  }
});

test("pg attributedTurns: covering join credits only user entries, per principal/session/day", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const scope = scopeId("channel", "uet");
  const a = await s.getOrCreateByThread("uetA", "channel", scope);
  const b = await s.getOrCreateByThread("uetB", "channel", scope);
  await s.addParticipant(a.id, "UET1");
  await s.addParticipant(b.id, "UET1");
  const { lease } = await s.acquireLease(a.id);
  const u0 = await s.append(lease!, { type: "user", payload: { text: "1" }, scopeLabel: scope });
  await s.append(lease!, { type: "assistant", payload: { text: "ack" }, scopeLabel: scope });
  const u1 = await s.append(lease!, { type: "user", payload: { text: "2" }, scopeLabel: scope });

  const rows = await s.attributedTurns();
  const forA = rows.filter((r) => r.sessionId === a.id);
  assert.equal(forA.length, 1, "one (principal, session, day) bucket");
  assert.equal(forA[0]!.principalId, "UET1");
  assert.equal(forA[0]!.turns, 2, "only the two user entries; assistant excluded");
  assert.equal(forA[0]!.firstAt, u0.createdAt);
  assert.equal(forA[0]!.lastAt, u1.createdAt);
  assert.equal(forA[0]!.day, Math.floor(u0.createdAt / 86_400_000));
  assert.equal(
    rows.some((r) => r.sessionId === b.id),
    false,
    "a session with no user entries yields no rows",
  );
});

test(
  "pg attributedTurns: the SQL covering join applies each window's [valid_from, valid_to) half-open",
  { skip },
  async () => {
    const nowRef = { v: 20_000_000_000 };
    const s = createPostgresSessionStore(URL!, { now: () => nowRef.v });
    const scope = scopeId("channel", "cov");
    const t0 = nowRef.v;
    const sess = await s.getOrCreateByThread("covA", "channel", scope);
    await s.addParticipant(sess.id, "COV1");
    const { lease } = await s.acquireLease(sess.id);
    nowRef.v = t0 + 1000;
    const early = await s.append(lease!, { type: "user", payload: { text: "early" }, scopeLabel: scope });
    nowRef.v = t0 + 2000;
    await s.addParticipant(sess.id, "COV2");
    nowRef.v = t0 + 3000;
    const mid = await s.append(lease!, { type: "user", payload: { text: "both" }, scopeLabel: scope });
    nowRef.v = t0 + 4000;
    await s.removeParticipant(sess.id, "COV2");
    nowRef.v = t0 + 5000;
    const late = await s.append(lease!, { type: "user", payload: { text: "late" }, scopeLabel: scope });
    await s.releaseLease(lease!);

    const rows = await s.attributedTurns();
    const c1 = rows.filter((r) => r.principalId === "COV1" && r.sessionId === sess.id);
    const c2 = rows.filter((r) => r.principalId === "COV2" && r.sessionId === sess.id);
    assert.equal(
      c1.reduce((n, r) => n + r.turns, 0),
      3,
      "the open-ended window gets all three turns",
    );
    assert.equal(c1[0]!.firstAt, early.createdAt);
    assert.equal(c1[0]!.lastAt, late.createdAt);
    assert.equal(
      c2.reduce((n, r) => n + r.turns, 0),
      1,
      "the closed window gets only the turn inside [valid_from, valid_to)",
    );
    assert.equal(c2[0]!.firstAt, mid.createdAt);
    assert.equal(c2[0]!.lastAt, mid.createdAt);
  },
);

test(
  "pg overheard catch-up entries are excluded from turns/preview/retention (jsonb payload filter)",
  { skip },
  async () => {
    const s = createPostgresSessionStore(URL!);
    const scope = scopeId("channel", "ov");
    const a = await s.getOrCreateByThread("ovA", "channel", scope);
    await s.addParticipant(a.id, "OV1");
    const { lease } = await s.acquireLease(a.id);
    await s.append(lease!, {
      type: "user",
      payload: { overheard: true, ts: "1", name: "Alice", text: "overheard chatter" },
      scopeLabel: scope,
    });
    await s.append(lease!, { type: "user", payload: { text: "the real question" }, scopeLabel: scope });
    await s.append(lease!, { type: "assistant", payload: { text: "answer" }, scopeLabel: scope });
    await s.append(lease!, {
      type: "user",
      payload: { overheard: true, ts: "2", name: "Bob", text: "more chatter" },
      scopeLabel: scope,
    });
    await s.releaseLease(lease!);

    const row = (await s.scopeSessionSummaries(scope, false)).find((r) => r.id === a.id)!;
    assert.equal(row.turns, 1, "summary turns excludes overheard");
    assert.equal(row.messages, 4, "messages still counts every durable entry");
    assert.equal(row.firstMessage, "the real question", "overheard is not the first message");
    assert.equal(row.lastMessage, "the real question", "overheard is not the last message");

    const stats = await s.scopeSessionStats(scope, false);
    assert.equal(stats.turns, 1, "stats turns excludes overheard");

    const attributed = (await s.attributedTurns()).filter((t) => t.sessionId === a.id);
    assert.equal(
      attributed.reduce((n, t) => n + t.turns, 0),
      1,
      "retention counts only the real user turn",
    );
  },
);

test("pg null-byte payloads: stripped on write, tolerated on read (no jsonb cast crash)", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const scope = scopeId("channel", "nul");
  const a = await s.getOrCreateByThread("nulA", "channel", scope);
  await s.addParticipant(a.id, "NUL1");
  const { lease } = await s.acquireLease(a.id);
  const e = await s.append(lease!, { type: "user", payload: { text: "a\u0000b" }, scopeLabel: scope });
  await s.releaseLease(lease!);
  assert.equal(
    (e.payload as { text?: string }).text,
    "ab",
    "append returns the sanitized payload, matching what is stored",
  );
  assert.equal(((await s.getEntries(a.id))[0]!.payload as { text?: string }).text, "ab", "null byte stripped at write");

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query(
      "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [a.id, 1, 0, "user", JSON.stringify({ text: "x\u0000y" }), scope, Date.now()],
    );
    await raw.query("UPDATE sessions SET messages = NULL, turns = NULL, last_activity = NULL WHERE id = $1", [a.id]);
  } finally {
    await raw.end();
  }
  const attributed = (await s.attributedTurns()).filter((t) => t.sessionId === a.id);
  assert.equal(
    attributed.reduce((n, t) => n + t.turns, 0),
    2,
    "both user turns counted; the poisoned legacy row does not crash the read",
  );
  const { lease: lease2 } = await s.acquireLease(a.id);
  await s.append(lease2!, { type: "user", payload: { text: "z" }, scopeLabel: scope });
  await s.releaseLease(lease2!);
  const row = (await s.scopeSessionSummaries(scope, false)).find((r) => r.id === a.id)!;
  assert.equal(row.turns, 3, "append recounts NULL turns; the poisoned row is counted, not crashed");
  assert.equal(row.messages, 3, "messages self-heal from the entry seq");
});

test("pg session counters: boot backfill fills pre-column rows", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const scope = scopeId("channel", "counters");
  const a = await s.getOrCreateByThread("countersA", "channel", scope);
  const b = await s.getOrCreateByThread("countersB", "channel", scope);
  const { lease } = await s.acquireLease(a.id);
  await s.append(lease!, { type: "user", payload: { text: "hi" }, scopeLabel: scope });
  await s.append(lease!, { type: "assistant", payload: { text: "yo" }, scopeLabel: scope });
  await s.append(lease!, { type: "user", payload: { text: "heard", overheard: true }, scopeLabel: scope });
  await s.releaseLease(lease!);

  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    await raw.query("UPDATE sessions SET messages = NULL, turns = NULL, last_activity = NULL WHERE id = ANY($1)", [
      [a.id, b.id],
    ]);
  } finally {
    await raw.end();
  }
  const s2 = createPostgresSessionStore(URL!);
  const rows = await s2.scopeSessionSummaries(scope, false);
  const ra = rows.find((r) => r.id === a.id)!;
  assert.equal(ra.messages, 3, "backfill counts every entry");
  assert.equal(ra.turns, 1, "backfill excludes overheard user rows");
  const entries = await s2.getEntries(a.id);
  assert.equal(ra.lastActivity, entries[entries.length - 1]!.createdAt, "backfill last-activity = newest entry");
  const rb = rows.find((r) => r.id === b.id)!;
  assert.equal(rb.messages, 0, "entry-less session backfills to zero");
  assert.equal(rb.lastActivity, rb.createdAt, "entry-less last-activity falls back to created_at");

  const raw2 = new pg.Pool({ connectionString: URL });
  try {
    await raw2.query(
      "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [a.id, 3, 2, "user", JSON.stringify({ text: "from the old instance" }), scope, Date.now()],
    );
  } finally {
    await raw2.end();
  }
  const { lease: lease2 } = await s2.acquireLease(a.id);
  await s2.append(lease2!, { type: "user", payload: { text: "back on new code" }, scopeLabel: scope });
  await s2.releaseLease(lease2!);
  const healed = (await s2.scopeSessionSummaries(scope, false)).find((r) => r.id === a.id)!;
  assert.equal(healed.messages, 5, "messages self-heal from the entry seq");
  assert.equal(healed.turns, 3, "seq/messages mismatch triggers a full turns recount");

  const raw3 = new pg.Pool({ connectionString: URL });
  try {
    await raw3.query(
      "INSERT INTO session_entries(session_id, seq, parent_seq, type, payload, scope_label, created_at) VALUES ($1,0,NULL,'user',$2,$3,$4), ($1,1,0,'assistant',$5,$3,$6)",
      [
        b.id,
        JSON.stringify({ text: "drained turn" }),
        scope,
        Date.now(),
        JSON.stringify({ text: "reply" }),
        Date.now() + 1,
      ],
    );
  } finally {
    await raw3.end();
  }
  const s3 = createPostgresSessionStore(URL!);
  const rb2 = (await s3.scopeSessionSummaries(scope, false)).find((r) => r.id === b.id)!;
  assert.equal(rb2.messages, 2, "boot recount repairs stale non-NULL counters on recently-active sessions");
  assert.equal(rb2.turns, 1, "boot recount restores turns the old writer never counted");

  const future = Date.now() + 5_000_000;
  const raw4 = new pg.Pool({ connectionString: URL });
  try {
    await raw4.query("UPDATE sessions SET last_activity = $2 WHERE id = $1", [a.id, future]);
    const { lease: lease3 } = await s3.acquireLease(a.id);
    await s3.append(lease3!, { type: "assistant", payload: { text: "late clock" }, scopeLabel: scope });
    await s3.releaseLease(lease3!);
    const ra2 = (await s3.scopeSessionSummaries(scope, false)).find((r) => r.id === a.id)!;
    assert.equal(ra2.lastActivity, future, "an older-clocked append never moves last_activity backwards");

    const s4 = createPostgresSessionStore(URL!);
    const ra3 = (await s4.scopeSessionSummaries(scope, false)).find((r) => r.id === a.id)!;
    assert.equal(ra3.lastActivity, future, "a boot recount never moves last_activity backwards either");

    await raw4.query("UPDATE sessions SET turns = 7 WHERE id = $1", [b.id]);
  } finally {
    await raw4.end();
  }
  const stats = await s3.scopeSessionStats(scope, false);
  assert.equal(stats.total, 2, "stats count sessions in scope");
  assert.equal(stats.turns, 3 + 7, "stats sum the stored turns counters, never the entries");
});

test("pg run store: enqueue dedup, atomic one-per-session claim, fencing, ledger, reaper", { skip }, async () => {
  const { runs, ledger, close } = createPostgresRunStore(URL!);
  try {
    const r1 = (await runs.enqueue({ sessionId: "sA", request: turn("1") })).run;
    await runs.enqueue({ sessionId: "sA", request: turn("2") });
    const rB = (await runs.enqueue({ sessionId: "sB", request: turn("b") })).run;
    const first = await runs.claim("w1", 5_000);
    assert.equal(first?.id, r1.id, "oldest pending claimed first");
    const second = await runs.claim("w2", 5_000);
    assert.equal(second?.id, rB.id, "sA already running → skip its 2nd, take sB");
    assert.equal(await runs.claim("w3", 5_000), null, "nothing else eligible");

    assert.equal(
      await runs.complete(first!.id, "wrong", { status: "ok" } as TurnResult),
      false,
      "fenced token can't complete",
    );
    assert.equal((await runs.get(first!.id))?.status, "running");
    assert.equal(await runs.complete(first!.id, first!.leaseToken!, { status: "ok", reply: "done" }), true);
    assert.equal((await runs.get(first!.id))?.status, "done");

    const a = await runs.enqueue({ sessionId: "s1", request: turn("hi"), dedupKey: "k1" });
    const b = await runs.enqueue({ sessionId: "s1", request: turn("again"), dedupKey: "k1" });
    assert.equal(b.deduped, true);
    assert.equal(b.run.id, a.run.id);

    const N = 8;
    const raced = await Promise.all(
      Array.from({ length: N }, (_, i) => runs.enqueue({ sessionId: "s2", request: turn(`c${i}`), dedupKey: "kc" })),
    );
    const racedIds = new Set(raced.map((r) => r.run.id));
    assert.equal(racedIds.size, 1, "all concurrent same-key enqueues return the same run");
    assert.equal(raced.filter((r) => r.deduped === false).length, 1, "exactly one inserter");
    assert.equal(raced.filter((r) => r.deduped === true).length, N - 1, "the rest are dedup hits");

    assert.equal((await ledger.begin("run1", 1, 0)).cached, false);
    await ledger.record("run1", 1, 0, JSON.stringify({ ok: true }));
    assert.deepEqual(JSON.parse((await ledger.begin("run1", 1, 0)).output ?? "null"), { ok: true });
    assert.equal((await ledger.begin("run1", 2, 0)).cached, false, "attempt 2 call 0 is a fresh slot");

    const r = (await runs.enqueue({ sessionId: "sR", request: turn("x"), maxAttempts: 3 })).run;
    await runs.claim("dead", 1);
    await new Promise((res) => setTimeout(res, 20));
    const swept = await runs.reapExpired();
    assert.ok(swept.requeued >= 1);
    assert.equal((await runs.get(r.id))?.status, "pending");
  } finally {
    await close();
  }
});

test(
  "pg run store: releaseLease (deploy drain) hands the run back as a retry without spending budget; stale token is a no-op",
  { skip },
  async () => {
    const { runs, close } = createPostgresRunStore(URL!);
    try {
      const r = (await runs.enqueue({ sessionId: "sDrain", request: turn("long turn") })).run;
      const claimed = await runs.claimById(r.id, "w1", 60_000);
      assert.equal(claimed?.id, r.id);
      const token = claimed!.leaseToken!;
      const claimCount = claimed!.attempts;

      assert.equal(await runs.releaseLease(r.id, "wrong-token"), false);
      assert.equal((await runs.get(r.id))?.status, "running");

      assert.equal(await runs.releaseLease(r.id, token), true);
      const released = await runs.get(r.id);
      assert.equal(released?.status, "pending", "released immediately, not after TTL");
      assert.equal(released?.leaseToken, null);
      assert.equal(released?.leaseExpiresAt, null);
      assert.equal(released?.workerId, null);
      assert.equal(released?.attempts, claimCount, "claim count untouched");
      assert.equal(released?.errorAttempts, 0, "a drain is not an error");

      const reclaimed = await runs.claimById(r.id, "w2", 60_000);
      assert.equal(reclaimed?.id, r.id);
      assert.equal(reclaimed?.attempts, claimCount + 1, "reclaim treated as a retry");
      assert.equal(reclaimed?.errorAttempts, 0);

      assert.equal(await runs.complete(r.id, reclaimed!.leaseToken!, { status: "ok", reply: "done" }), true);
      assert.equal(await runs.releaseLease(r.id, reclaimed!.leaseToken!), false);
      assert.equal((await runs.get(r.id))?.status, "done");
    } finally {
      await close();
    }
  },
);

test("pg run store: delivery state round-trips; onTerminal fires once with it", { skip }, async () => {
  const { runs, close } = createPostgresRunStore(URL!);
  try {
    const r = (await runs.enqueue({ sessionId: "sDeliver", request: turn("x") })).run;
    assert.equal(r.deliveryState, null);
    assert.equal(await runs.setDeliveryState("missing", null, { editRef: "1.2" }), false);
    assert.equal(await runs.setDeliveryState(r.id, null, { editRef: "171.002" }), true);
    assert.equal((await runs.get(r.id))?.deliveryState?.editRef, "171.002");

    const seen: string[] = [];
    runs.onTerminal((run) => seen.push(`${run.id}:${run.status}:${run.deliveryState?.editRef ?? ""}`));
    const claimed = await runs.claimById(r.id, "w1", 5_000);
    await runs.complete(r.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
    assert.deepEqual(seen, [`${r.id}:done:171.002`], "terminal listener sees the checkpointed state");

    const parked = (await runs.enqueue({ sessionId: "sPark", request: turn("y"), maxAttempts: 1 })).run;
    const c = await runs.claimById(parked.id, "w2", 5_000);
    await runs.fail(parked.id, c!.leaseToken!, "boom", { retry: true });
    assert.equal(seen.length, 2, "exhausted attempts park the run and fire");
    assert.equal(seen[1], `${parked.id}:failed:`);
  } finally {
    await close();
  }
});

test("pg run store: reaper cannot clobber a run that completed or renewed its lease mid-sweep", { skip }, async () => {
  const { runs, close } = createPostgresRunStore(URL!);
  try {
    const retiredSessions: string[] = [];
    const collect = async (ids: string[]): Promise<void> => {
      retiredSessions.push(...ids);
    };

    const completed = (await runs.enqueue({ sessionId: "sweepDone", request: turn("x") })).run;
    const claimedDone = await runs.claimById(completed.id, "w1", 1);
    assert.ok(claimedDone?.leaseToken);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(await runs.complete(completed.id, claimedDone!.leaseToken!, { status: "ok", reply: "won" }), true);
    await runs.reapExpired(collect);
    const done = await runs.get(completed.id);
    assert.equal(done?.status, "done", "completed run is not flipped back to pending");
    assert.equal(done?.result?.reply, "won");
    assert.ok(!retiredSessions.includes("sweepDone"), "a completed run's session is never released by the sweep");

    const renewed = (await runs.enqueue({ sessionId: "sweepAlive", request: turn("y") })).run;
    const claimedAlive = await runs.claimById(renewed.id, "w2", 1);
    assert.ok(claimedAlive?.leaseToken);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(await runs.heartbeat(renewed.id, claimedAlive!.leaseToken!, 60_000), true);
    await runs.reapExpired(collect);
    assert.equal((await runs.get(renewed.id))?.status, "running", "renewed lease survives the sweep");
    assert.ok(!retiredSessions.includes("sweepAlive"), "a renewed run's session is never released by the sweep");
  } finally {
    await close();
  }
});

test("pg run store: reaper parks over-age runs, requeues young ones, and audits every reap", { skip }, async () => {
  const { runs, close } = createPostgresRunStore(URL!);
  try {
    type ReapEvent = import("../src/runs/run-store.ts").ReapEvent;

    const old = (await runs.enqueue({ sessionId: "ageOld", request: turn("poison") })).run;
    assert.ok((await runs.claimById(old.id, "wOld", 1))?.leaseToken);
    await new Promise((res) => setTimeout(res, 20));
    const oldEvents: ReapEvent[] = [];
    const sweptOld = await runs.reapExpired(undefined, { maxAgeMs: 5, onReap: (e) => oldEvents.push(e) });
    assert.equal(sweptOld.parked, 1, "an over-age run parks");
    assert.equal(sweptOld.requeued, 0);
    const parked = await runs.get(old.id);
    assert.equal(parked?.status, "failed", "park is a loud terminal failure");
    assert.match(parked?.result?.reason ?? "", /max age/);
    assert.equal(parked?.errorAttempts, 0, "age-cap park does not spend the error budget");
    const oldEv = oldEvents.find((e) => e.runId === old.id);
    assert.equal(oldEv?.outcome, "parked");
    assert.equal(oldEv?.sessionId, "ageOld");
    assert.equal(oldEv?.workerId, "wOld");
    assert.equal(oldEv?.attempts, 1);
    assert.equal(oldEv?.errorAttempts, 0);

    const young = (await runs.enqueue({ sessionId: "ageYoung", request: turn("normal") })).run;
    assert.ok((await runs.claimById(young.id, "wYoung", 1))?.leaseToken);
    await new Promise((res) => setTimeout(res, 20));
    const youngEvents: ReapEvent[] = [];
    const sweptYoung = await runs.reapExpired(undefined, { maxAgeMs: 600_000, onReap: (e) => youngEvents.push(e) });
    assert.equal(sweptYoung.requeued, 1, "a young expired run requeues");
    assert.equal(sweptYoung.parked, 0);
    assert.equal((await runs.get(young.id))?.status, "pending");
    const youngEv = youngEvents.find((e) => e.runId === young.id);
    assert.equal(youngEv?.outcome, "requeued");
    assert.equal(youngEv?.workerId, "wYoung");
    assert.equal(youngEv?.errorAttempts, 0);
  } finally {
    await close();
  }
});

test("pg run store: one-running-per-session holds under concurrent claims (unique index)", { skip }, async () => {
  const { runs, close } = createPostgresRunStore(URL!);
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const r1 = (await runs.enqueue({ sessionId: "sRace", request: turn("a") })).run;
    const r2 = (await runs.enqueue({ sessionId: "sRace", request: turn("b") })).run;
    assert.ok(await runs.claimById(r1.id, "w1", 60_000));

    await assert.rejects(
      raw.query("UPDATE runs SET status='running' WHERE id=$1", [r2.id]),
      /idx_runs_one_running_per_session/,
      "partial unique index blocks a second running row for the session",
    );
    assert.equal(await runs.claimById(r2.id, "w2", 60_000), null, "claimById refuses while a sibling runs");

    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => runs.claim(`race-${i}`, 60_000)));
    const raceClaims = claims.filter((run) => run?.sessionId === "sRace");
    assert.equal(raceClaims.length, 0, "concurrent claims never double-run a session");
    assert.equal((await runs.get(r2.id))?.status, "pending", "the queued sibling stays queued");
  } finally {
    await raw.end();
    await close();
  }
});

test(
  "pg run store: same-instant submissions keep send order, and the claim takes the displayed head",
  { skip },
  async () => {
    const { runs, close } = createPostgresRunStore(URL!);
    try {
      // created_at is Date.now(), so six quick enqueues tie; seq breaks the tie in insertion
      // order. The queue read and the claim agree on it, so what a surface shows as next IS next.
      const created = [];
      for (let i = 0; i < 6; i++) created.push((await runs.enqueue({ sessionId: "sSeq", request: turn(`m${i}`) })).run);
      const expected = created.map((r) => r.id);
      assert.deepEqual(
        (await runs.inFlightForThread("sSeq")).map((r) => r.id),
        expected,
        "the queue reads back in send order even when created_at ties",
      );
      const claimed = await runs.claim("wSeq", 60_000);
      assert.equal(claimed?.id, expected[0], "the worker claims exactly the head the queue displays");

      // Rows that predate the seq column get backfilled in heap order, not send order. seq is a
      // tie-break BEHIND created_at, so a scrambled backfill can only ever decide between rows
      // sharing a millisecond — simulate the worst backfill and prove created_at still rules.
      const pg = (await import("pg")).default;
      const raw = new pg.Pool({ connectionString: URL });
      try {
        const early = (await runs.enqueue({ sessionId: "sBackfill", request: turn("early") })).run;
        await new Promise((r) => setTimeout(r, 5));
        const late = (await runs.enqueue({ sessionId: "sBackfill", request: turn("late") })).run;
        await raw.query("UPDATE runs SET seq = 999999999 WHERE id = $1", [early.id]);
        assert.deepEqual(
          (await runs.inFlightForThread("sBackfill")).map((r) => r.id),
          [early.id, late.id],
          "created_at outranks a scrambled seq",
        );
      } finally {
        await raw.end();
      }
    } finally {
      await close();
    }
  },
);

test("pg run store: withdraw and claim cannot both win the same queued run", { skip }, async () => {
  const { runs, close } = createPostgresRunStore(URL!);
  try {
    const live = (await runs.enqueue({ sessionId: "sWd", request: turn("live") })).run;
    assert.ok(await runs.claimById(live.id, "w1", 60_000));
    // Eight withdrawals of one queued run: the DELETE is guarded on status='pending', so exactly
    // one can report success — the surface never shows a message as both removed and running.
    const queued = (await runs.enqueue({ sessionId: "sWd", request: turn("queued") })).run;
    const results = await Promise.all(Array.from({ length: 8 }, () => runs.withdraw(queued.id)));
    assert.equal(results.filter(Boolean).length, 1, "exactly one withdrawal wins");
    assert.equal(await runs.get(queued.id), null);

    // And against a claim: whoever loses reports honestly rather than silently dropping the turn.
    const contested = (await runs.enqueue({ sessionId: "sWd2", request: turn("contested") })).run;
    const [withdrawn, claimed] = await Promise.all([
      runs.withdraw(contested.id),
      runs.claimById(contested.id, "w2", 60_000),
    ]);
    assert.notEqual(withdrawn, Boolean(claimed), "the run is either withdrawn or running, never both");
  } finally {
    await close();
  }
});

test("pg run store indexes newest active run by session", { skip }, async () => {
  const { close } = createPostgresRunStore(URL!);
  const pg = (await import("pg")).default;
  const raw = new pg.Pool({ connectionString: URL });
  try {
    const result = await raw.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_runs_session_active_created'",
    );
    assert.match(
      result.rows[0]?.indexdef ?? "",
      /\(session_id, created_at DESC\).*WHERE \(status = ANY \(ARRAY.*pending.*running/,
    );
  } finally {
    await raw.end();
    await close();
  }
});

test(
  "pg run store: schema init demotes pre-existing duplicate running rows before creating the index",
  { skip },
  async () => {
    const pg = (await import("pg")).default;
    const raw = new pg.Pool({ connectionString: URL });
    try {
      await raw.query("DROP INDEX IF EXISTS idx_runs_one_running_per_session");
      const req = JSON.stringify(turn("dup"));
      await raw.query(
        `INSERT INTO runs(id, session_id, status, request, created_at, started_at)
       VALUES ('dup-keep', 'sDup', 'running', $1, 1, 1), ('dup-demote', 'sDup', 'running', $1, 2, 2)`,
        [req],
      );

      const { runs, close } = createPostgresRunStore(URL!);
      try {
        assert.equal((await runs.get("dup-keep"))?.status, "running", "earliest running row survives");
        assert.equal((await runs.get("dup-demote"))?.status, "pending", "later duplicate is requeued");
      } finally {
        await close();
      }
    } finally {
      await raw.end();
    }
  },
);

test("pg sessionsByThreadRefs + distinctScopes: bulk projections match a full listAll scan", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const eng = scopeId("channel", "CENG");
  const uma = scopeId("personal", "UMA");
  const a = await s.getOrCreateByThread("btr-a", "channel", eng, "eng");
  await s.getOrCreateByThread("btr-b", "channel", eng);
  await s.getOrCreateByThread("btr-c", "dm", uma);
  await s.updateTitle(a.id, "board deck");

  const all = await s.listAll();
  const byRefExpected = new Map(all.map((x) => [x.threadRef, x]));
  const refs = await s.sessionsByThreadRefs(["btr-a", "btr-c", "btr-missing"]);
  assert.deepEqual(refs.map((r) => r.threadRef).sort(), ["btr-a", "btr-c"], "only existing refs returned");
  const ra = refs.find((r) => r.threadRef === "btr-a")!;
  assert.equal(ra.scopeId, byRefExpected.get("btr-a")!.scopeId);
  assert.equal(ra.type, byRefExpected.get("btr-a")!.type);
  assert.equal(ra.title, "board deck", "title projected");
  assert.equal(refs.find((r) => r.threadRef === "btr-c")!.type, "dm");
  assert.deepEqual(await s.sessionsByThreadRefs([]), [], "empty input short-circuits");

  const distinct = new Map((await s.distinctScopes()).map((d) => [d.scopeId, d.channelName]));
  const scopesFromAll = new Set(all.map((x) => x.scopeId));
  assert.deepEqual([...distinct.keys()].sort(), [...scopesFromAll].sort(), "same distinct scope set as listAll");
  assert.equal(distinct.get(eng), "eng", "a non-null channel name wins for the scope");
  assert.equal(distinct.get(uma), undefined, "no channel name for a personal scope");
});

test("pg participant view: pin/color are per-participant, survive re-add, and clear", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const scope = scopeId("channel", "CPIN");
  const sess = await s.getOrCreateByThread("pv-pin", "channel", scope);
  await s.addParticipant(sess.id, "U1");
  await s.addParticipant(sess.id, "U2");

  await s.updateParticipantView(sess.id, "U1", { title: "Mine", pinned: true, color: "#3b82f6" });
  const u1 = (await s.listByParticipant("U1")).find((x) => x.id === sess.id)!;
  assert.equal(u1.pinned, true);
  assert.equal(u1.color, "#3b82f6");
  const u2 = (await s.listByParticipant("U2")).find((x) => x.id === sess.id)!;
  assert.ok(!u2.pinned, "one participant's pin never pins the thread for another");
  assert.equal(u2.color ?? null, null);

  await s.removeParticipant(sess.id, "U1");
  await s.addParticipant(sess.id, "U1");
  const readded = (await s.listByParticipant("U1")).find((x) => x.id === sess.id)!;
  assert.equal(readded.pinned, true, "pin survives re-add");
  assert.equal(readded.color, "#3b82f6", "color survives re-add");

  await s.updateParticipantView(sess.id, "U1", { pinned: false, color: null });
  const cleared = (await s.listByParticipant("U1")).find((x) => x.id === sess.id)!;
  assert.ok(!cleared.pinned);
  assert.equal(cleared.color ?? null, null, "null clears the color");
});

test(
  "pg deleteSessionIfEmpty: an expired lease forfeits, and the stale holder cannot orphan entries",
  { skip },
  async () => {
    const s = createPostgresSessionStore(URL!, { leaseTtlMs: 40 });
    const scope = scopeId("personal", "USTALE");
    const sess = await s.getOrCreateByThread("web:USTALE:seed", "dm", scope);
    const att = await s.acquireLease(sess.id);
    assert.ok(att.lease);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(await s.deleteSessionIfEmpty(sess.id), true, "an expired lease does not block the discard");
    assert.equal(await s.get(sess.id), null);
    await assert.rejects(
      s.append(att.lease!, { type: "user", payload: {}, scopeLabel: scope }),
      /valid session lease/,
      "the stale holder cannot append after the discard",
    );
    const pg = (await import("pg")).default;
    const raw = new pg.Pool({ connectionString: URL });
    const leftovers = await raw.query(
      "SELECT (SELECT COUNT(*) FROM session_entries WHERE session_id = $1) AS e, (SELECT COUNT(*) FROM session_leases WHERE session_id = $1) AS l",
      [sess.id],
    );
    await raw.end();
    assert.equal(Number(leftovers.rows[0].e), 0, "no orphaned entries after the stale append is refused");
    assert.equal(Number(leftovers.rows[0].l), 0, "no orphaned lease row survives");
  },
);

test("pg deleteSession: racing a fresh lease acquisition never orphans entries", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const scope = scopeId("personal", "UHARD");
  for (let i = 0; i < 15; i++) {
    const sess = await s.getOrCreateByThread(`web:UHARD:${i}`, "dm", scope);
    const [attempt] = await Promise.all([s.acquireLease(sess.id), s.deleteSession(sess.id)]);
    assert.equal(await s.get(sess.id), null, "the session is gone either way");
    if (attempt.lease) {
      await assert.rejects(
        s.append(attempt.lease, { type: "user", payload: {}, scopeLabel: scope }),
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

test("pg deleteSessionIfEmpty: racing a fresh lease acquisition never orphans the lease", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
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

test("pg deleteSessionIfEmpty: a held lease or landed entries refuse the discard atomically", { skip }, async () => {
  const s = createPostgresSessionStore(URL!);
  const scope = scopeId("personal", "UDISC");
  const sess = await s.getOrCreateByThread("web:UDISC:seed", "dm", scope);
  const att = await s.acquireLease(sess.id);
  assert.ok(att.lease);
  assert.equal(await s.deleteSessionIfEmpty(sess.id), false, "a held lease blocks the discard");
  await s.append(att.lease, { type: "user", payload: { text: "seed" }, scopeLabel: scope });
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
    "SELECT (SELECT COUNT(*) FROM session_entries WHERE session_id = $1) AS e, (SELECT COUNT(*) FROM session_leases WHERE session_id = $1) AS l",
    [empty.id],
  );
  await raw.end();
  assert.equal(Number(orphans.rows[0].e), 0, "no orphaned entries survive the discard");
  assert.equal(Number(orphans.rows[0].l), 0, "no orphaned lease survives the discard");
});
