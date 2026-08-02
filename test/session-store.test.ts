import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import { cronIdOf, sessionOrigin } from "../src/sessions/session-store.ts";
import { scopeId } from "../src/types.ts";

test("sessionOrigin classifies trigger threads by prefix", () => {
  assert.equal(sessionOrigin("agent:main:cron:abc"), "cron");
  assert.equal(sessionOrigin("agent:main:webhook:abc"), "webhook");
  assert.equal(sessionOrigin("agent:main:monitor:abc"), "monitor");
  assert.equal(sessionOrigin("cron:c1:slot"), "cron");
  assert.equal(sessionOrigin("dm:D1"), "conversation");
  assert.equal(sessionOrigin("ch:C1:t1"), "conversation");
  assert.equal(sessionOrigin(null), "conversation");
  assert.equal(sessionOrigin(undefined), "conversation");
});

test("attributedTurns applies each window's [validFrom,validTo) and excludes overheard", async () => {
  const nowRef = { v: 10_000_000_000 };
  const store = createMemorySessionStore({ now: () => nowRef.v });
  const scope = scopeId("channel", "C1");
  const t0 = nowRef.v;
  const s = await store.getOrCreateByThread("ch:C1:t1", "channel", scope);
  await store.addParticipant(s.id, "U1");
  const { lease } = await store.acquireLease(s.id);
  assert.ok(lease);
  nowRef.v = t0 + 1000;
  const early = await store.append(lease, { type: "user", payload: { text: "early, U1 only" }, scopeLabel: scope });
  nowRef.v = t0 + 2000;
  await store.addParticipant(s.id, "U2");
  nowRef.v = t0 + 3000;
  await store.append(lease, { type: "user", payload: { overheard: true, text: "chatter" }, scopeLabel: scope });
  nowRef.v = t0 + 4000;
  const mid = await store.append(lease, { type: "user", payload: { text: "both here" }, scopeLabel: scope });
  nowRef.v = t0 + 5000;
  await store.removeParticipant(s.id, "U2");
  nowRef.v = t0 + 6000;
  const late = await store.append(lease, { type: "user", payload: { text: "U1 only again" }, scopeLabel: scope });
  await store.releaseLease(lease);

  const rows = await store.attributedTurns();
  const u1 = rows.filter((r) => r.principalId === "U1" && r.sessionId === s.id);
  const u2 = rows.filter((r) => r.principalId === "U2" && r.sessionId === s.id);
  assert.equal(
    u1.reduce((n, r) => n + r.turns, 0),
    3,
    "U1 (open-ended) gets all three real turns; overheard excluded",
  );
  assert.equal(u1[0]!.firstAt, early.createdAt);
  assert.equal(u1[0]!.lastAt, late.createdAt);
  assert.equal(
    u2.reduce((n, r) => n + r.turns, 0),
    1,
    "U2 gets only the turn inside [validFrom,validTo)",
  );
  assert.equal(u2[0]!.firstAt, mid.createdAt);
  assert.equal(u2[0]!.lastAt, mid.createdAt);
});

test("a blocked acquire names, dates, and times out the holder it lost to", async () => {
  const nowRef = { v: 10_000_000_000 };
  const t0 = nowRef.v;
  const store = createMemorySessionStore({ now: () => nowRef.v, leaseTtlMs: 60_000 });
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("t1", "dm", scope);
  const { lease } = await store.acquireLease(s.id, "compaction");
  assert.ok(lease);

  nowRef.v = t0 + 15_000;
  const blocked = await store.acquireLease(s.id, "turn");
  assert.equal(blocked.lease, null, "the live lease still blocks a second writer");
  assert.equal(blocked.heldBy, "compaction", "the refusal can say WHAT kind of work outranked it");
  assert.equal(blocked.heldSince, t0, "…when that work took the lock");
  assert.equal(blocked.heldUntil, t0 + 60_000, "…and when the lock lapses on its own");

  await store.append(lease, { type: "user", payload: { text: "still working" }, scopeLabel: scope });
  const later = await store.acquireLease(s.id, "turn");
  assert.equal(later.heldSince, t0, "the age still measures from the acquire");
  assert.equal(later.heldUntil, t0 + 75_000, "the expiry moved with the write");

  nowRef.v = t0 + 200_000;
  const past = await store.acquireLease(s.id, "turn");
  assert.ok(past.lease, "an expired holder no longer blocks");
  assert.equal(past.heldUntil, undefined, "a won acquire reports no holder");
});

const backends: Array<[string, () => SessionStore]> = [["memory", () => createMemorySessionStore()]];

for (const [name, make] of backends) {
  test(`${name}: fork provenance is available through get and participant lists`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const session = await store.getOrCreateByThread("fork", "dm", scope);
    await store.addParticipant(session.id, "U1");
    const provenance = { forkedFrom: { sessionId: "source", title: "Original" }, forkBoundarySeq: 7 };
    await store.updateForkProvenance(session.id, provenance);
    assert.deepEqual(await store.get(session.id), { ...session, ...provenance });
    assert.deepEqual((await store.listByParticipant("U1"))[0]?.forkedFrom, provenance.forkedFrom);
    assert.equal((await store.listByParticipant("U1"))[0]?.forkBoundarySeq, 7);
  });

  test(`${name}: one session per thread (getOrCreateByThread is idempotent)`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const a = await store.getOrCreateByThread("t1", "dm", scope);
    const b = await store.getOrCreateByThread("t1", "dm", scope);
    const c = await store.getOrCreateByThread("t2", "dm", scope);
    assert.equal(a.id, b.id);
    assert.notEqual(a.id, c.id);
  });

  test(`${name}: single-writer lease + monotonic seq`, async () => {
    const store = make();
    const s = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));

    const { lease } = await store.acquireLease(s.id);
    assert.ok(lease);
    assert.equal((await store.acquireLease(s.id)).lease, null);

    const e0 = await store.append(lease, { type: "user", payload: { text: "hi" }, scopeLabel: s.scopeId });
    const e1 = await store.append(lease, { type: "assistant", payload: { text: "yo" }, scopeLabel: s.scopeId });
    assert.equal(e0.seq, 0);
    assert.equal(e1.seq, 1);
    assert.equal(e1.parentSeq, 0);

    await store.releaseLease(lease);
    await assert.rejects(store.append(lease, { type: "user", payload: {}, scopeLabel: s.scopeId }));
  });

  test(`${name}: getByThread is a pure lookup (null on miss, never creates)`, async () => {
    const store = make();
    assert.equal(await store.getByThread("nope"), null, "missing thread → null, no session created");
    const s = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));
    const got = await store.getByThread("t1");
    assert.equal(got?.id, s.id);
    assert.equal(await store.getByThread("still-nope"), null);
  });

  test(`${name}: scopeSessionSummaries tags each row with its origin (conversation vs cron)`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.getOrCreateByThread("agent:main:cron:c1", "dm", scope);
    const rows = await store.scopeSessionSummaries(scope, false);
    const byThreadOrigin = new Map(rows.map((r) => [r.id, r.origin]));
    const conv = await store.getByThread("dm:D1");
    const cron = await store.getByThread("agent:main:cron:c1");
    assert.equal(byThreadOrigin.get(conv!.id), "conversation");
    assert.equal(byThreadOrigin.get(cron!.id), "cron");
  });

  test(`${name}: scopeSessionStats rolls up totals/turns/byType across the whole scope`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const dm = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.getOrCreateByThread("agent:main:cron:c1", "dm", scope);
    const { lease } = await store.acquireLease(dm.id);
    assert.ok(lease);
    await store.append(lease, { type: "user", payload: { text: "hi" }, scopeLabel: scope });
    await store.append(lease, { type: "user", payload: { text: "again" }, scopeLabel: scope });
    await store.releaseLease(lease);

    const stats = await store.scopeSessionStats(scope, false);
    assert.equal(stats.total, 2, "both sessions counted");
    assert.equal(stats.turns, 2, "two user entries across the scope");
    assert.equal(stats.byType.dm, 1, "the conversation buckets by channel type");
    assert.equal(stats.byType.cron, 1, "the trigger thread buckets by origin");
    assert.deepEqual(stats.totalByCategory, { conversation: 1, background: 1, all: 2 });

    const conversationStats = await store.scopeSessionStats(scope, false, "conversation");
    assert.equal(conversationStats.total, 1);
    assert.deepEqual(conversationStats.totalByCategory, { conversation: 1, background: 1, all: 2 });
    const backgroundStats = await store.scopeSessionStats(scope, false, "background");
    assert.equal(backgroundStats.total, 1);
    assert.equal(backgroundStats.byType.cron, 1);
  });

  test(`${name}: overheard catch-up entries are NOT counted as turns or as the first/last message`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("ch:C1:t1", "channel", scope);
    await store.addParticipant(s.id, "U1");
    const { lease } = await store.acquireLease(s.id);
    assert.ok(lease);
    await store.append(lease, {
      type: "user",
      payload: { overheard: true, ts: "1", name: "Alice", text: "overheard chatter" },
      scopeLabel: scope,
    });
    await store.append(lease, { type: "user", payload: { text: "the real question" }, scopeLabel: scope });
    await store.append(lease, { type: "assistant", payload: { text: "answer" }, scopeLabel: scope });
    await store.append(lease, {
      type: "user",
      payload: { overheard: true, ts: "2", name: "Bob", text: "more chatter" },
      scopeLabel: scope,
    });
    await store.releaseLease(lease);

    const stats = await store.scopeSessionStats(scope, false);
    assert.equal(stats.turns, 1, "only the real user turn counts; the two overheard rows do not");

    const rows = await store.scopeSessionSummaries(scope, false);
    const row = rows.find((r) => r.id === s.id)!;
    assert.equal(row.turns, 1, "summary turns excludes overheard");
    assert.equal(row.firstMessage, "the real question", "the overheard row is not the first message");
    assert.equal(row.lastMessage, "the real question", "the overheard row is not the last message");
    assert.equal(row.messages, 4, "messages still counts every durable entry, overheard included");

    const attributed = (await store.attributedTurns()).filter((t) => t.sessionId === s.id);
    assert.equal(
      attributed.reduce((n, t) => n + t.turns, 0),
      1,
      "retention/usage counts only the real user turn",
    );

    const light = await store.scopeSessionSummaries(scope, false, undefined, false);
    const lightRow = light.find((r) => r.id === s.id)!;
    assert.equal(lightRow.turns, 1, "light rows still carry counts");
    assert.deepEqual([lightRow.firstMessage, lightRow.lastMessage], ["", ""], "light rows omit previews");
    const previews = await store.lastUserMessages([s.id]);
    assert.equal(
      previews.get(s.id),
      "the real question",
      "lastUserMessages returns the latest real user turn, skipping overheard",
    );
    assert.equal((await store.lastUserMessages([])).size, 0, "empty id set → empty map");
  });

  test(`${name}: scopeSessionSummaries paginates newest-activity-first`, async () => {
    let clock = Date.now() + 1_000_000;
    const store = createMemorySessionStore({ now: () => ++clock });
    const scope = scopeId("personal", "U1");
    const a = await store.getOrCreateByThread("dm:A", "dm", scope);
    const b = await store.getOrCreateByThread("dm:B", "dm", scope);
    await store.getOrCreateByThread("dm:C", "dm", scope);
    const { lease: la } = await store.acquireLease(a.id);
    await store.append(la!, { type: "user", payload: { text: "a" }, scopeLabel: scope });
    await store.releaseLease(la!);
    const { lease: lb } = await store.acquireLease(b.id);
    await store.append(lb!, { type: "user", payload: { text: "b" }, scopeLabel: scope });
    await store.releaseLease(lb!);

    const page1 = await store.scopeSessionSummaries(scope, false, { limit: 2, offset: 0 });
    assert.equal(page1.length, 2);
    assert.equal(page1[0]!.id, b.id, "most recent activity first");
    assert.equal(page1[1]!.id, a.id);
    const page2 = await store.scopeSessionSummaries(scope, false, { limit: 2, offset: 2 });
    assert.equal(page2.length, 1, "third session on the next page");
    assert.equal((await store.scopeSessionSummaries(scope, false)).length, 3, "unpaginated still returns all");
  });

  test(`${name}: scopeSessionSummaries filters category before paginating`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const convo = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.getOrCreateByThread("agent:main:cron:c1", "dm", scope);
    await store.getOrCreateByThread("agent:main:webhook:wh1", "dm", scope);

    const conversations = await store.scopeSessionSummaries(scope, false, {
      limit: 10,
      offset: 0,
      category: "conversation",
    });
    assert.deepEqual(
      conversations.map((r) => r.id),
      [convo.id],
    );

    const background = await store.scopeSessionSummaries(scope, false, { limit: 1, offset: 0, category: "background" });
    assert.equal(background.length, 1);
    assert.notEqual(background[0]!.id, convo.id);
    assert.equal(background[0]!.origin === "cron" || background[0]!.origin === "webhook", true);
  });

  test(`${name}: scopeSessionSummaries filters origin before paginating`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const cron = await store.getOrCreateByThread("agent:main:cron:c1", "dm", scope);
    const webhook = await store.getOrCreateByThread("agent:main:webhook:wh1", "dm", scope);

    const cronRows = await store.scopeSessionSummaries(scope, false, {
      limit: 1,
      offset: 0,
      category: "background",
      origin: "cron",
    });
    assert.deepEqual(
      cronRows.map((r) => r.id),
      [cron.id],
    );

    const otherRows = await store.scopeSessionSummaries(scope, false, {
      limit: 1,
      offset: 0,
      category: "background",
      origin: "other_background",
    });
    assert.deepEqual(
      otherRows.map((r) => r.id),
      [webhook.id],
    );

    const cronStats = await store.scopeSessionStats(scope, false, "background", "cron");
    assert.equal(cronStats.total, 1);
    assert.equal(cronStats.byType.cron, 1);
    assert.deepEqual(cronStats.totalByCategory, { conversation: 0, background: 2, all: 2 });

    const otherStats = await store.scopeSessionStats(scope, false, "background", "other_background");
    assert.equal(otherStats.total, 1);
    assert.equal(otherStats.byType.webhook, 1);
  });

  test(`${name}: scopeCronGroups rolls up one row per cron; cronId page filters one cron's fires`, async () => {
    const store = make();
    const scope = scopeId("channel", "C1");
    const c1a = await store.getOrCreateByThread("cron:c1:slot1", "channel", scope);
    const c1b = await store.getOrCreateByThread("cron:c1:slot2", "channel", scope);
    const c2 = await store.getOrCreateByThread("agent:main:cron:c2", "channel", scope);
    await store.getOrCreateByThread("agent:main:webhook:wh1", "channel", scope);
    await store.getOrCreateByThread("dm:D9", "dm", scopeId("personal", "U9"));
    const { lease } = await store.acquireLease(c1a.id);
    await store.append(lease!, { type: "user", payload: { text: "fire" }, scopeLabel: scope });
    await store.append(lease!, { type: "assistant", payload: { text: "done" }, scopeLabel: scope });

    const groups = await store.scopeCronGroups(scope, false);
    assert.deepEqual(
      groups.map((g) => g.cronId).sort(),
      ["c1", "c2"],
      "one row per cron, webhook and conversations excluded",
    );
    const g1 = groups.find((g) => g.cronId === "c1")!;
    assert.equal(g1.sessions, 2, "counts every fire session of the cron");
    assert.equal(g1.turns, 1);
    assert.equal(g1.messages, 2);
    assert.equal(g1.scopeId, scope);
    const g2 = groups.find((g) => g.cronId === "c2")!;
    assert.deepEqual([g2.sessions, g2.turns, g2.messages], [1, 0, 0], "entry-less fire still counted");
    assert.equal(g2.lastActivity, c2.createdAt);

    const fresh = await store.getOrCreateByThread("cron:c1:slot3", "channel", scope);
    const regrouped = await store.scopeCronGroups(scope, false);
    assert.equal(
      regrouped.find((g) => g.cronId === "c1")!.lastActivity,
      fresh.createdAt,
      "a fresh entry-less fire advances the group's last activity past older fires' entries",
    );

    const cronStats = await store.scopeSessionStats(scope, false, "background", "cron", "c1");
    assert.equal(cronStats.total, 3, "stats cronId filter counts one cron's fires");

    const fires = await store.scopeSessionSummaries(scope, false, { limit: 10, offset: 0, cronId: "c1" });
    assert.deepEqual(
      fires.map((r) => r.id).sort(),
      [c1a.id, c1b.id, fresh.id].sort(),
      "cronId page returns only that cron's fires",
    );
    const page = await store.scopeSessionSummaries(scope, false, { limit: 1, offset: 1, cronId: "c1" });
    assert.equal(page.length, 1, "cronId filter applies before pagination");
    assert.deepEqual(await store.scopeCronGroups(scopeId("channel", "other"), false), [], "scope filter applies");
  });

  test(`${name}: forceReleaseLease drops a held lease so a fresh acquire succeeds (reaper path)`, async () => {
    const store = make();
    const s = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));
    const { lease } = await store.acquireLease(s.id);
    assert.ok(lease);
    assert.equal((await store.acquireLease(s.id)).lease, null, "lease is held");
    await store.forceReleaseLease(s.id);
    const { lease: reacquired } = await store.acquireLease(s.id);
    assert.ok(reacquired, "lease was force-released, so a new writer can acquire");
    await assert.rejects(store.append(lease, { type: "user", payload: {}, scopeLabel: s.scopeId }));
  });

  test(`${name}: updateTitle sets the session's display title (absent until set)`, async () => {
    const store = make();
    const s = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));
    assert.equal((await store.get(s.id))?.title, undefined);
    await store.updateTitle(s.id, "Deploy Pipeline Triage");
    assert.equal((await store.get(s.id))?.title, "Deploy Pipeline Triage");
    assert.equal(
      (await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"))).title,
      "Deploy Pipeline Triage",
    );
    await store.updateTitle(s.id, "Blue-Green Cutover");
    assert.equal((await store.get(s.id))?.title, "Blue-Green Cutover");
  });

  test(`${name}: getOrCreateByThread captures + self-heals the origin channel name`, async () => {
    const store = make();
    const scope = scopeId("channel", "C1");
    const a = await store.getOrCreateByThread("ch:C1:root", "channel", scope, "project-alpha");
    assert.equal(a.channelName, "project-alpha");
    assert.equal((await store.get(a.id))?.channelName, "project-alpha");
    assert.equal(
      (await store.listByParticipant("U1").then(() => store.getOrCreateByThread("ch:C1:root", "channel", scope)))
        .channelName,
      "project-alpha",
    );
    const b = await store.getOrCreateByThread("ch:C1:root", "channel", scope, "project-alpha-prime");
    assert.equal(b.id, a.id);
    assert.equal(b.channelName, "project-alpha-prime");
    assert.equal((await store.get(a.id))?.channelName, "project-alpha-prime");
    const dm = await store.getOrCreateByThread("dm:U1", "dm", scopeId("personal", "U1"));
    assert.equal(dm.channelName, undefined);
  });

  test(`${name}: getOrCreateByThread records + backfills the session's surface (§1)`, async () => {
    const store = make();
    const scope = scopeId("channel", "C1");
    const bare = await store.getOrCreateByThread("slack/C1/root", "channel", scope);
    assert.equal(bare.surface, undefined);
    const healed = await store.getOrCreateByThread("slack/C1/root", "channel", scope, undefined, "slack");
    assert.equal(healed.id, bare.id);
    assert.equal(healed.surface, "slack");
    assert.equal((await store.get(bare.id))?.surface, "slack");
    const fresh = await store.getOrCreateByThread("web/conv-1", "dm", scopeId("personal", "U1"), undefined, "web");
    assert.equal(fresh.surface, "web");
  });

  test(`${name}: recordLlmRequest is a per-session diagnostics sidecar, apart from the entry log`, async () => {
    const store = make();
    const s = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));
    const rec = await store.recordLlmRequest(s.id, {
      turnSeq: 0,
      step: 0,
      model: "claude-x",
      scopeLabel: s.scopeId,
      promptEnvelope: { system: "you are helpful", tools: [{ name: "execute" }] },
    });
    assert.ok(rec.id, "stamps an id");
    assert.equal(rec.truncated, false, "defaults truncated to false");
    assert.equal(rec.ttftMs, null, "per-call timing defaults to null when not captured");
    assert.equal(rec.usage, null, "usage defaults to null when the provider reported none");
    assert.equal(rec.transport, null, "transport defaults to null when not captured");
    await store.recordLlmRequest(s.id, {
      turnSeq: 0,
      step: 1,
      model: "claude-x",
      scopeLabel: s.scopeId,
      truncated: true,
      ttftMs: 1200,
      durationMs: 8400,
      usage: { input: 30, output: 120, cacheRead: 5000, cacheWrite: 0, totalTokens: 5150, costUsd: 0.0123 },
      transport: { modelId: "claude-x", headers: { "anthropic-beta": "fast-mode-2026" } },
    });

    const list = await store.listLlmRequests(s.id);
    assert.equal(list.length, 2, "both snapshots stored");
    assert.deepEqual(
      list.map((r) => r.step),
      [0, 1],
      "ordered by step within the turn",
    );
    assert.equal(list[0]!.turnSeq, 0, "correlated to the turn's user entry seq");
    assert.equal(list[1]!.truncated, true, "truncated flag round-trips");
    assert.equal(list[0]!.request, null, "message-array bodies are never stored");
    assert.deepEqual(
      list[0]!.promptEnvelope,
      { system: "you are helpful", tools: [{ name: "execute" }] },
      "prompt envelope round-trips via its hash",
    );
    assert.ok(list[0]!.promptHash, "envelope rows carry the dedup hash");
    assert.equal(list[1]!.promptHash, null, "rows recorded without an envelope stay bare");
    const repeat = await store.recordLlmRequest(s.id, {
      turnSeq: 1,
      step: 0,
      model: "claude-x",
      scopeLabel: s.scopeId,
      promptEnvelope: { system: "you are helpful", tools: [{ name: "execute" }] },
    });
    assert.equal(repeat.promptHash, list[0]!.promptHash, "identical envelopes dedupe to one stored body");
    const rehydrated = await store.listLlmRequests(s.id, { turnSeqs: [1] });
    assert.deepEqual(
      rehydrated[0]!.promptEnvelope,
      { system: "you are helpful", tools: [{ name: "execute" }] },
      "the deduped row still hydrates its envelope",
    );
    assert.equal(list[1]!.ttftMs, 1200, "per-call TTFT round-trips");
    assert.equal(list[1]!.durationMs, 8400, "per-call duration round-trips");
    assert.deepEqual(
      list[1]!.usage,
      { input: 30, output: 120, cacheRead: 5000, cacheWrite: 0, totalTokens: 5150, costUsd: 0.0123 },
      "per-call usage round-trips",
    );
    assert.deepEqual(
      list[1]!.transport,
      { modelId: "claude-x", headers: { "anthropic-beta": "fast-mode-2026" } },
      "transport (model id + headers) round-trips",
    );

    assert.equal((await store.getEntries(s.id)).length, 0, "captured requests are not session entries");
    assert.equal((await store.listLlmRequests("nope")).length, 0, "unknown session → empty");
  });

  test(`${name}: listLlmRequests filters by turnSeq in the store (no load-all-then-filter)`, async () => {
    const store = make();
    const s = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));
    const base = { model: "claude-x", scopeLabel: s.scopeId, promptEnvelope: { system: "sys" } };
    await store.recordLlmRequest(s.id, { ...base, turnSeq: 0, step: 0 });
    await store.recordLlmRequest(s.id, { ...base, turnSeq: 5, step: 0 });
    await store.recordLlmRequest(s.id, { ...base, turnSeq: 5, step: 1 });

    assert.equal((await store.listLlmRequests(s.id)).length, 3, "no filter → all requests");
    const onlyFive = await store.listLlmRequests(s.id, { turnSeqs: [5] });
    assert.deepEqual(
      onlyFive.map((r) => r.turnSeq),
      [5, 5],
      "filters to the requested turn(s)",
    );
    assert.deepEqual(
      (await store.listLlmRequests(s.id, { turnSeqs: [0, 5] })).map((r) => r.turnSeq),
      [0, 5, 5],
      "multiple turnSeqs union",
    );
    assert.equal((await store.listLlmRequests(s.id, { turnSeqs: [] })).length, 0, "empty turnSeqs → empty");
    assert.equal((await store.listLlmRequests(s.id, { turnSeqs: [99] })).length, 0, "unmatched turnSeq → empty");

    await store.recordLlmRequest(s.id, { ...base, turnSeq: null, step: 0 });
    assert.deepEqual(
      (await store.listLlmRequests(s.id, { orphans: true })).map((r) => r.turnSeq),
      [null],
      "orphans → null-turn rows only",
    );
    const union = await store.listLlmRequests(s.id, { turnSeqs: [5], orphans: true });
    assert.equal(union.filter((r) => r.turnSeq === 5).length, 2, "turnSeqs + orphans keeps the turn rows");
    assert.equal(union.filter((r) => r.turnSeq === null).length, 1, "…and unions in the orphan");

    const meta = await store.listLlmRequests(s.id, { omitRequest: true });
    assert.equal(meta.length, 4, "every row still listed");
    assert.ok(
      meta.every((r) => r.request === null && r.promptEnvelope === undefined),
      "bodies omitted",
    );
    assert.ok(
      meta.every((r) => r.model === "claude-x"),
      "metadata retained",
    );
  });

  test(`${name}: attributedTurns credits only user entries inside a participant's window, per session/day`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const a = await store.getOrCreateByThread("t1", "dm", scope);
    const b = await store.getOrCreateByThread("t2", "dm", scope);
    await store.addParticipant(a.id, "U1");
    await store.addParticipant(b.id, "U1");
    const { lease } = await store.acquireLease(a.id);
    assert.ok(lease);
    const u0 = await store.append(lease, { type: "user", payload: { text: "1" }, scopeLabel: scope });
    await store.append(lease, { type: "assistant", payload: { text: "ack" }, scopeLabel: scope });
    const u1 = await store.append(lease, { type: "user", payload: { text: "2" }, scopeLabel: scope });

    const rows = await store.attributedTurns();
    const forA = rows.filter((r) => r.sessionId === a.id);
    assert.equal(forA.length, 1, "one (principal, session, day) bucket");
    assert.equal(forA[0]!.principalId, "U1");
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

  test(`${name}: listByParticipant powers unified history`, async () => {
    const store = make();
    const s1 = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));
    const s2 = await store.getOrCreateByThread("t2", "channel", scopeId("channel", "C1"));
    await store.addParticipant(s1.id, "U1");
    await store.addParticipant(s2.id, "U1");
    await store.addParticipant(s2.id, "U2");
    assert.equal((await store.listByParticipant("U1")).length, 2);
    assert.equal((await store.listByParticipant("U2")).length, 1);
  });

  test(`${name}: deleteSession hard-removes the session and its rows`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("t1", "dm", scope);
    const keep = await store.getOrCreateByThread("t2", "dm", scope);
    await store.addParticipant(s.id, "U1");
    await store.addParticipant(keep.id, "U1");
    const { lease } = await store.acquireLease(s.id);
    await store.append(lease!, { type: "user", payload: { text: "hi" }, scopeLabel: scope });
    await store.releaseLease(lease!);

    await store.deleteSession(s.id);

    assert.equal(await store.get(s.id), null, "session gone");
    assert.equal(await store.getByThread("t1"), null, "thread index cleared");
    assert.equal((await store.getEntries(s.id)).length, 0, "entries gone");
    assert.equal(
      (await store.listByParticipant("U1")).some((x) => x.id === s.id),
      false,
      "dropped from the user's list",
    );
    assert.equal(
      (await store.listByParticipant("U1")).some((x) => x.id === keep.id),
      true,
      "other sessions untouched",
    );
    assert.equal((await store.acquireLease(s.id)).lease, null, "no lease is granted on a deleted session");
    const reborn = await store.getOrCreateByThread("t1", "dm", scope);
    assert.notEqual(reborn.id, s.id, "the thread gets a fresh session");
    assert.notEqual((await store.acquireLease(reborn.id)).lease, null, "the fresh session is leasable");
  });

  test(`${name}: listByParticipant sets lastActivityAt to the most recent user message`, async () => {
    let clock = Date.now() + 1_000_000;
    const store = createMemorySessionStore({ now: () => ++clock });
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.addParticipant(s.id, "U1");
    const { lease } = await store.acquireLease(s.id);
    assert.ok(lease);
    await store.append(lease, { type: "user", payload: { text: "hi" }, scopeLabel: scope });
    const lastUser = await store.append(lease, { type: "user", payload: { text: "still here" }, scopeLabel: scope });
    await store.append(lease, { type: "assistant", payload: { text: "yo" }, scopeLabel: scope });
    await store.append(lease, { type: "tool_call", payload: {}, scopeLabel: scope });
    await store.releaseLease(lease);

    const row = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
    assert.equal(
      row.lastActivityAt,
      lastUser.createdAt,
      "tracks the last user message, ignoring the agent's later assistant/tool entries",
    );
  });

  test(`${name}: listByParticipant falls back to createdAt for an entry-less session`, async () => {
    let clock = Date.now() + 1_000_000;
    const store = createMemorySessionStore({ now: () => ++clock });
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.addParticipant(s.id, "U1");

    const row = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
    assert.equal(row.lastActivityAt, s.createdAt, "an entry-less session falls back to its creation time");
  });

  test(`${name}: listByParticipant reports whether the transcript has any entries`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.addParticipant(s.id, "U1");

    assert.equal((await store.listByParticipant("U1")).find((x) => x.id === s.id)?.hasEntries, false, "no entries yet");

    const { lease } = await store.acquireLease(s.id);
    assert.ok(lease);
    await store.append(lease, { type: "system", payload: { text: "note" }, scopeLabel: scope });
    await store.releaseLease(lease);

    assert.equal(
      (await store.listByParticipant("U1")).find((x) => x.id === s.id)?.hasEntries,
      true,
      "flips once anything lands",
    );
  });

  test(`${name}: tenure windows remain exact when every event shares a timestamp`, async () => {
    const clock = Date.now() + 1_000_000;
    const store = createMemorySessionStore({ now: () => clock });
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.addParticipant(s.id, "U1");
    const { lease } = await store.acquireLease(s.id);
    assert.ok(lease);
    await store.append(lease, { type: "user", payload: { text: "hi" }, scopeLabel: scope });

    await store.removeParticipant(s.id, "U1");
    await store.addParticipant(s.id, "U1");
    assert.equal(
      (await store.listByParticipant("U1")).find((x) => x.id === s.id)?.hasEntries,
      false,
      "old entries fall outside the new tenure",
    );

    await store.append(lease, { type: "user", payload: { text: "welcome back" }, scopeLabel: scope });
    assert.equal(
      (await store.listByParticipant("U1")).find((x) => x.id === s.id)?.hasEntries,
      true,
      "an entry inside the new tenure counts",
    );
  });

  test(`${name}: a participant's rename and archive survive remove/re-add`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.addParticipant(s.id, "U1");
    await store.updateParticipantView(s.id, "U1", { title: "My name", archived: true, pinned: true, color: "#3b82f6" });

    await store.removeParticipant(s.id, "U1");
    await store.addParticipant(s.id, "U1");

    const row = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
    assert.equal(row.title, "My name", "rename survives");
    assert.equal(row.archived, true, "archive survives");
    assert.equal(row.pinned, true, "pin survives");
    assert.equal(row.color, "#3b82f6", "color survives");
  });

  test(`${name}: updateParticipantView rename/archive is per-participant`, async () => {
    const store = make();
    const s = await store.getOrCreateByThread("t1", "channel", scopeId("channel", "C1"));
    await store.addParticipant(s.id, "U1");
    await store.addParticipant(s.id, "U2");

    const before = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
    assert.equal(before.title ?? null, null);
    assert.ok(!before.archived);

    await store.updateParticipantView(s.id, "U1", { title: "Roadmap", archived: true });
    const u1 = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
    assert.equal(u1.title, "Roadmap");
    assert.equal(u1.archived, true);

    const u2 = (await store.listByParticipant("U2")).find((x) => x.id === s.id)!;
    assert.equal(u2.title ?? null, null);
    assert.ok(!u2.archived);

    await store.updateParticipantView(s.id, "U1", { title: null, archived: false });
    const u1b = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
    assert.equal(u1b.title ?? null, null);
    assert.ok(!u1b.archived);

    await store.updateParticipantView(s.id, "U3", { title: "nope" });
    assert.equal((await store.listByParticipant("U3")).length, 0);
  });

  test(`${name}: updateParticipantView pin/color is per-participant and clears`, async () => {
    const store = make();
    const s = await store.getOrCreateByThread("t-pin", "channel", scopeId("channel", "C2"));
    await store.addParticipant(s.id, "U1");
    await store.addParticipant(s.id, "U2");

    const before = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
    assert.ok(!before.pinned);
    assert.equal(before.color ?? null, null);

    await store.updateParticipantView(s.id, "U1", { pinned: true, color: "#ef4444" });
    const u1 = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
    assert.equal(u1.pinned, true);
    assert.equal(u1.color, "#ef4444");

    const u2 = (await store.listByParticipant("U2")).find((x) => x.id === s.id)!;
    assert.ok(!u2.pinned, "one participant's pin never pins the thread for another");
    assert.equal(u2.color ?? null, null, "one participant's color never colors it for another");

    await store.updateParticipantView(s.id, "U1", { pinned: false, color: null });
    const u1b = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
    assert.ok(!u1b.pinned);
    assert.equal(u1b.color ?? null, null);
  });

  test(`${name}: addParticipant can initialize a private title without resetting an active tenure`, async () => {
    const store = make();
    const scope = scopeId("group", "G1");
    const session = await store.getOrCreateByThread("t1", "group", scope);
    await store.updateTitle(session.id, "Earlier discussion");
    await store.addParticipant(session.id, "U1", "");
    assert.equal((await store.listByParticipant("U1"))[0]?.title, "");

    const { lease } = await store.acquireLease(session.id);
    assert.ok(lease);
    await store.append(lease, { type: "user", payload: { text: "visible" }, scopeLabel: scope });
    await store.addParticipant(session.id, "U1", "My project chat");
    assert.equal((await store.visibleEntries(session.id, "U1")).length, 1);
    assert.equal((await store.listByParticipant("U1"))[0]?.title, "My project chat");
  });

  test(`${name}: stats' distinct-cron count always equals the rows scopeCronGroups lists`, async () => {
    const store = make();
    const scope = scopeId("channel", "C1");
    await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.getOrCreateByThread("agent:main:cron:stable1", "dm", scope);
    await store.getOrCreateByThread("cron:legacy1:slot1", "dm", scope);
    await store.getOrCreateByThread("cron:legacy1:slot2", "dm", scope);
    await store.getOrCreateByThread("cron:legacy2", "dm", scope);
    await store.getOrCreateByThread("agent:main:webhook:wh1", "dm", scope);

    const stats = await store.scopeSessionStats(scope, false);
    const groups = await store.scopeCronGroups(scope, false);
    assert.equal(stats.crons, 3, "distinct crons, not fires");
    assert.equal(stats.crons, groups.length, "tab count == listable rows (one classifier)");
    assert.equal(stats.byType.cron, 4, "byType still counts cron sessions (fires)");
    assert.equal(
      groups.reduce((n, g) => n + g.sessions, 0),
      stats.byType.cron,
      "every counted cron session is listed under some cron",
    );
    assert.equal(
      (await store.scopeSessionStats(scope, false, "conversation")).crons,
      3,
      "crons ignores the active filter",
    );
  });

  test(`${name}: keyset cursor pages match offset pages and skip nothing`, async () => {
    let clock = Date.now() + 1_000_000;
    const store = createMemorySessionStore({ now: () => ++clock });
    const scope = scopeId("personal", "U1");
    for (let i = 0; i < 5; i++) {
      const s = await store.getOrCreateByThread(`dm:K${i}`, "dm", scope);
      const { lease } = await store.acquireLease(s.id);
      await store.append(lease!, { type: "user", payload: { text: `m${i}` }, scopeLabel: scope });
      await store.releaseLease(lease!);
    }
    const all = await store.scopeSessionSummaries(scope, false, { limit: 10, offset: 0 });
    const page1 = await store.scopeSessionSummaries(scope, false, { limit: 2, offset: 0 });
    const cursor1 = page1[page1.length - 1]!;
    const page2 = await store.scopeSessionSummaries(scope, false, {
      limit: 2,
      offset: 0,
      before: { lastActivity: cursor1.lastActivity, id: cursor1.id },
    });
    const cursor2 = page2[page2.length - 1]!;
    const page3 = await store.scopeSessionSummaries(scope, false, {
      limit: 2,
      offset: 0,
      before: { lastActivity: cursor2.lastActivity, id: cursor2.id },
    });
    assert.deepEqual(
      [...page1, ...page2, ...page3].map((r) => r.id),
      all.map((r) => r.id),
      "cursor pages stitch into the full newest-first listing",
    );
    assert.equal(page3.length, 1, "final partial page");
  });
}

test("cronIdOf and sessionOrigin agree on which threadRefs are crons", () => {
  const refs = [
    "agent:main:cron:abc",
    "cron:abc",
    "cron:abc:slot",
    "cron:abc:slot:extra",
    "agent:main:webhook:x",
    "webhook:x:y",
    "dm:D1",
    "cron:",
    "agent:main:cron:abc:extra",
  ];
  for (const ref of refs) {
    assert.equal(cronIdOf(ref) !== null, sessionOrigin(ref) === "cron", `classifiers agree on ${ref}`);
  }
  assert.equal(cronIdOf("agent:main:cron:abc"), "abc");
  assert.equal(cronIdOf("cron:abc:slot"), "abc");
  assert.equal(cronIdOf("dm:D1"), null);
});

test("deleteSessionIfEmpty refuses while a lease is held and after entries land", async () => {
  const nowRef = { v: 10_000_000_000 };
  const store = createMemorySessionStore({ now: () => nowRef.v, leaseTtlMs: 50 });
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("web:U1:seed", "dm", scope);
  const { lease } = await store.acquireLease(s.id);
  assert.ok(lease);
  assert.equal(await store.deleteSessionIfEmpty(s.id), false, "a held lease blocks the discard");
  await store.append(lease, { type: "user", payload: { text: "seed" }, scopeLabel: scope });
  await store.releaseLease(lease);
  assert.equal(await store.deleteSessionIfEmpty(s.id), false, "entries block the discard");
  const empty = await store.getOrCreateByThread("web:U1:seed2", "dm", scope);
  const second = await store.acquireLease(empty.id);
  assert.ok(second.lease);
  await store.releaseLease(second.lease);
  assert.equal(await store.deleteSessionIfEmpty(empty.id), true, "a released empty session is discarded");
  assert.equal(await store.get(empty.id), null);
  assert.equal((await store.acquireLease(empty.id)).lease, null, "no lease is granted on a discarded session");

  const abandoned = await store.getOrCreateByThread("web:U1:seed3", "dm", scope);
  const stale = await store.acquireLease(abandoned.id);
  assert.ok(stale.lease);
  nowRef.v += 60;
  assert.equal(await store.deleteSessionIfEmpty(abandoned.id), true, "an expired lease does not block the discard");
  await assert.rejects(
    store.append(stale.lease, { type: "user", payload: {}, scopeLabel: scope }),
    /valid session lease/,
    "the stale holder cannot append after the discard",
  );
});
