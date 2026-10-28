import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import { scopeId } from "../../src/types.ts";
import { assertParticipantSessionParity } from "../support/participant-session-parity.ts";
import { assertSpendRollupParity } from "../support/spend-rollup-parity.ts";

const backends: Array<[string, () => SessionStore]> = [
  ["postgres", () => createPostgresSessionStore(testDatabaseUrl())],
];

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

    const e0 = await store.append(lease, { kind: "UserMessage", text: "hi" });
    const e1 = await store.append(lease, { kind: "AgentMessage", text: "yo" });
    assert.equal(e0.seq, 0);
    assert.equal(e1.seq, 1);

    await store.releaseLease(lease);
    await assert.rejects(store.append(lease, { kind: "UserMessage" }));
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
    const rows = await store.scopeSessionSummaries(scope, false, { limit: 500 });
    const byThreadOrigin = new Map(rows.map((r) => [r.id, r.origin]));
    const conv = await store.getByThread("dm:D1");
    const cron = await store.getByThread("agent:main:cron:c1");
    assert.equal(byThreadOrigin.get(conv!.id), "conversation");
    assert.equal(byThreadOrigin.get(cron!.id), "cron");
  });

  test(`${name}: scopeActivity counts conversations, cron fires and other background per scope`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const dm = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.getOrCreateByThread("agent:main:cron:c1", "dm", scope);
    await store.getOrCreateByThread("cron:c1:slot2", "dm", scope);
    await store.getOrCreateByThread("agent:main:webhook:wh1", "dm", scope);
    await store.getOrCreateByThread("dm:D9", "dm", scopeId("personal", "U9"));
    const { lease } = await store.acquireLease(dm.id);
    await store.append(lease!, { kind: "UserMessage", text: "hi" });
    await store.releaseLease(lease!);

    const rows = new Map((await store.scopeActivity()).map((r) => [r.scopeId, r]));
    assert.deepEqual([rows.get(scope)?.conversations, rows.get(scope)?.crons, rows.get(scope)?.background], [1, 2, 1]);
    assert.equal(rows.get(scopeId("personal", "U9"))?.conversations, 1, "every scope gets its own row");
  });

  test(`${name}: overheard catch-up entries are NOT counted as turns or as the first/last message`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("ch:C1:t1", "channel", scope);
    await store.addParticipant(s.id, "U1");
    const { lease } = await store.acquireLease(s.id);
    assert.ok(lease);
    await store.append(lease, {
      kind: "UserMessage",
      externalId: "1",
      text: "overheard chatter",
      body: { overheard: true, name: "Alice" },
    });
    await store.append(lease, { kind: "UserMessage", text: "the real question" });
    await store.append(lease, { kind: "AgentMessage", text: "answer" });
    await store.append(lease, {
      kind: "UserMessage",
      externalId: "2",
      text: "more chatter",
      body: { overheard: true, name: "Bob" },
    });
    await store.releaseLease(lease);

    const rows = await store.scopeSessionSummaries(scope, false, { limit: 500 });
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
  });

  test(`${name}: scopeSessionSummaries paginates newest-activity-first`, async () => {
    let clock = Date.now() + 1_000_000;
    const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => (clock += 61_000) });
    const scope = scopeId("personal", "U1");
    const a = await store.getOrCreateByThread("dm:A", "dm", scope);
    const b = await store.getOrCreateByThread("dm:B", "dm", scope);
    await store.getOrCreateByThread("dm:C", "dm", scope);
    const { lease: la } = await store.acquireLease(a.id);
    await store.append(la!, { kind: "UserMessage", text: "a" });
    await store.releaseLease(la!);
    const { lease: lb } = await store.acquireLease(b.id);
    await store.append(lb!, { kind: "UserMessage", text: "b" });
    await store.releaseLease(lb!);

    const page1 = await store.scopeSessionSummaries(scope, false, { limit: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page1[0]!.id, b.id, "most recent activity first");
    assert.equal(page1[1]!.id, a.id);
    const page2 = await store.scopeSessionSummaries(scope, false, {
      limit: 2,
      before: { lastActivity: page1[1]!.lastActivity, id: page1[1]!.id },
    });
    assert.equal(page2.length, 1, "third session on the next page");
    assert.equal(
      (await store.scopeSessionSummaries(scope, false, { limit: 500 })).length,
      3,
      "a wide page returns all",
    );
  });

  test(`${name}: scopeSessionSummaries filters category before paginating`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const convo = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.getOrCreateByThread("agent:main:cron:c1", "dm", scope);
    await store.getOrCreateByThread("agent:main:webhook:wh1", "dm", scope);

    const conversations = await store.scopeSessionSummaries(scope, false, {
      limit: 10,
      category: "conversation",
    });
    assert.deepEqual(
      conversations.map((r) => r.id),
      [convo.id],
    );

    const background = await store.scopeSessionSummaries(scope, false, { limit: 1, category: "background" });
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
      category: "background",
      origin: "cron",
    });
    assert.deepEqual(
      cronRows.map((r) => r.id),
      [cron.id],
    );

    const otherRows = await store.scopeSessionSummaries(scope, false, {
      limit: 1,
      category: "background",
      origin: "other_background",
    });
    assert.deepEqual(
      otherRows.map((r) => r.id),
      [webhook.id],
    );
  });

  test(`${name}: cronId page filters one cron's fires`, async () => {
    const store = make();
    const scope = scopeId("channel", "C1");
    const c1a = await store.getOrCreateByThread("cron:c1:slot1", "channel", scope);
    const c1b = await store.getOrCreateByThread("cron:c1:slot2", "channel", scope);
    await store.getOrCreateByThread("agent:main:cron:c2", "channel", scope);
    await store.getOrCreateByThread("agent:main:webhook:wh1", "channel", scope);
    const fresh = await store.getOrCreateByThread("cron:c1:slot3", "channel", scope);

    const fires = await store.scopeSessionSummaries(scope, false, { limit: 10, cronId: "c1" });
    assert.deepEqual(
      fires.map((r) => r.id).sort(),
      [c1a.id, c1b.id, fresh.id].sort(),
      "cronId page returns only that cron's fires",
    );
    const page = await store.scopeSessionSummaries(scope, false, {
      limit: 1,
      cronId: "c1",
      before: { lastActivity: fires[0]!.lastActivity, id: fires[0]!.id },
    });
    assert.equal(page.length, 1, "cronId filter applies before pagination");
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
    await assert.rejects(store.append(lease, { kind: "UserMessage" }));
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
    });
    assert.ok(rec.id, "stamps an id");
    assert.equal(rec.ttftMs, null, "per-call timing defaults to null when not captured");
    assert.equal(rec.usage, null, "usage defaults to null when the provider reported none");
    assert.equal(rec.transport, null, "transport defaults to null when not captured");
    await store.recordLlmRequest(s.id, {
      turnSeq: 0,
      step: 1,
      model: "claude-x",
      scopeLabel: s.scopeId,
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

    assert.equal((await store.getItems(s.id)).length, 0, "captured requests are not session entries");
    assert.equal((await store.listLlmRequests("nope")).length, 0, "unknown session → empty");
  });

  test(`${name}: listLlmRequests filters by turnSeq in the store (no load-all-then-filter)`, async () => {
    const store = make();
    const s = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));
    const base = { model: "claude-x", scopeLabel: s.scopeId };
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
    const u0 = await store.append(lease, { kind: "UserMessage", text: "1" });
    await store.append(lease, { kind: "AgentMessage", text: "ack" });
    const u1 = await store.append(lease, { kind: "UserMessage", text: "2" });

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

  test(`${name}: bounded participant listing returns recent rows and keeps the unbounded API`, async () => {
    const store = make();
    for (let i = 0; i < 5; i++) {
      const session = await store.getOrCreateByThread(`bounded:${i}`, "dm", scopeId("personal", "bounded-user"));
      await store.addParticipant(session.id, "bounded-user");
    }
    assert.equal((await store.listByParticipant("bounded-user")).length, 5);
    assert.equal((await store.listByParticipant("bounded-user", { limit: 2 })).length, 2);
    assert.equal((await store.listByParticipant("bounded-user", { limit: 0 })).length, 0);
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

  test(`${name}: getForParticipant returns exactly the row listByParticipant returns`, async () => {
    const store = make();
    await assertParticipantSessionParity(store, `parity-${name}-a`);
    await assertParticipantSessionParity(store, `parity-${name}-b`);
  });

  test(`${name}: spendRollup groups model-call cost by UTC day, scope, origin and model`, async () => {
    await assertSpendRollupParity((now) => createPostgresSessionStore(testDatabaseUrl(), { now }), `spend-${name}`);
  });

  test(`${name}: countSessions and distinctParticipants aggregate without loading rows`, async () => {
    const store = make();
    const scope = scopeId("channel", "CAGG");
    assert.equal(await store.countSessions(), 0);
    assert.deepEqual(await store.distinctParticipants(), []);
    const a = await store.getOrCreateByThread("agg-a", "channel", scope);
    const b = await store.getOrCreateByThread("agg-b", "channel", scope);
    await store.addParticipant(a.id, "U1");
    await store.addParticipant(b.id, "U1");
    await store.addParticipant(b.id, "U2");
    await store.removeParticipant(b.id, "U2");
    assert.equal(await store.countSessions(), 2);
    assert.deepEqual((await store.distinctParticipants()).sort(), ["U1", "U2"], "one id per person, removed included");
    await store.deleteSession(b.id);
    assert.equal(await store.countSessions(), 1);
    assert.deepEqual(await store.distinctParticipants(), ["U1"]);
  });

  test(`${name}: deleteSession hard-removes the session and its rows`, async () => {
    const store = make();
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("t1", "dm", scope);
    const keep = await store.getOrCreateByThread("t2", "dm", scope);
    await store.addParticipant(s.id, "U1");
    await store.addParticipant(keep.id, "U1");
    const { lease } = await store.acquireLease(s.id);
    await store.append(lease!, { kind: "UserMessage", text: "hi" });
    await store.releaseLease(lease!);

    await store.deleteSession(s.id);

    assert.equal(await store.get(s.id), null, "session gone");
    assert.equal(await store.getByThread("t1"), null, "thread index cleared");
    assert.equal((await store.getItems(s.id)).length, 0, "entries gone");
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
    const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => ++clock });
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.addParticipant(s.id, "U1");
    const { lease } = await store.acquireLease(s.id);
    assert.ok(lease);
    await store.append(lease, { kind: "UserMessage", text: "hi" });
    const lastUser = await store.append(lease, { kind: "UserMessage", text: "still here" });
    await store.append(lease, { kind: "AgentMessage", text: "yo" });
    await store.append(lease, { kind: "ToolCall", tool: "execute", callId: "c1" });
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
    const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => ++clock });
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
    await store.append(lease, { kind: "Wake", wakeCause: "system", body: { text: "note" } });
    await store.releaseLease(lease);

    assert.equal(
      (await store.listByParticipant("U1")).find((x) => x.id === s.id)?.hasEntries,
      true,
      "flips once anything lands",
    );
  });

  test(`${name}: tenure windows remain exact when every event shares a timestamp`, async () => {
    const clock = Date.now() + 1_000_000;
    const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => clock });
    const scope = scopeId("personal", "U1");
    const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
    await store.addParticipant(s.id, "U1");
    const { lease } = await store.acquireLease(s.id);
    assert.ok(lease);
    await store.append(lease, { kind: "UserMessage", text: "hi" });

    await store.removeParticipant(s.id, "U1");
    await store.addParticipant(s.id, "U1");
    assert.equal(
      (await store.listByParticipant("U1")).find((x) => x.id === s.id)?.hasEntries,
      false,
      "old entries fall outside the new tenure",
    );

    await store.append(lease, { kind: "UserMessage", text: "welcome back" });
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
    await store.append(lease, { kind: "UserMessage", text: "visible" });
    await store.addParticipant(session.id, "U1", "My project chat");
    assert.equal((await store.visibleItems(session.id, "U1")).length, 1);
    assert.equal((await store.listByParticipant("U1"))[0]?.title, "My project chat");
  });

  test(`${name}: keyset cursor pages stitch into the full listing and skip nothing`, async () => {
    let clock = Date.now() + 1_000_000;
    const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => ++clock });
    const scope = scopeId("personal", "U1");
    for (let i = 0; i < 5; i++) {
      const s = await store.getOrCreateByThread(`dm:K${i}`, "dm", scope);
      const { lease } = await store.acquireLease(s.id);
      await store.append(lease!, { kind: "UserMessage", text: `m${i}` });
      await store.releaseLease(lease!);
    }
    const all = await store.scopeSessionSummaries(scope, false, { limit: 10 });
    const page1 = await store.scopeSessionSummaries(scope, false, { limit: 2 });
    const cursor1 = page1[page1.length - 1]!;
    const page2 = await store.scopeSessionSummaries(scope, false, {
      limit: 2,
      before: { lastActivity: cursor1.lastActivity, id: cursor1.id },
    });
    const cursor2 = page2[page2.length - 1]!;
    const page3 = await store.scopeSessionSummaries(scope, false, {
      limit: 2,
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
