import { test } from "node:test";
import assert from "node:assert/strict";
import { cronIdOf, sessionCategory, sessionOrigin } from "../src/sessions/session-store.ts";
import { parseSessionWakeRef } from "../src/api/routes/admin/origins.ts";
import { scopeId } from "../src/types.ts";
import { assertParticipantSessionParity } from "./support/participant-session-parity.ts";
import { assertSpendRollupParity } from "./support/spend-rollup-parity.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

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

test("scopeHasSessions + listByScope answer scope questions directly", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("channel", "scoped");
  const other = scopeId("channel", "other");
  assert.equal(await store.scopeHasSessions(scope), false);
  const a = await store.getOrCreateByThread("scopedA", "channel", scope);
  const b = await store.getOrCreateByThread("scopedB", "channel", scope);
  await store.getOrCreateByThread("scopedC", "channel", other);
  assert.equal(await store.scopeHasSessions(scope), true);
  assert.deepEqual(
    new Set((await store.listByScope(scope)).map((s) => s.id)),
    new Set([a.id, b.id]),
    "only the asked-for scope comes back",
  );
});

test(`fork provenance is available through get and participant lists`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const session = await store.getOrCreateByThread("fork", "dm", scope);
  await store.addParticipant(session.id, "U1");
  const provenance = { forkedFrom: { sessionId: "source", title: "Original" }, forkBoundarySeq: 7 };
  await store.updateForkProvenance(session.id, provenance);
  assert.deepEqual(await store.get(session.id), { ...session, ...provenance });
  assert.deepEqual((await store.listByParticipant("U1"))[0]?.forkedFrom, provenance.forkedFrom);
  assert.equal((await store.listByParticipant("U1"))[0]?.forkBoundarySeq, 7);
});

test(`one session per thread (getOrCreateByThread is idempotent)`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const a = await store.getOrCreateByThread("t1", "dm", scope);
  const b = await store.getOrCreateByThread("t1", "dm", scope);
  const c = await store.getOrCreateByThread("t2", "dm", scope);
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
});

test(`monotonic seq`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const s = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));

  const writer = { sessionId: s.id };

  const e0 = await store.append(writer, { kind: "UserMessage", text: "hi" });
  const e1 = await store.append(writer, { kind: "AgentMessage", text: "yo" });
  assert.equal(e0.seq, 0);
  assert.equal(e1.seq, 1);
});

test(`getByThread is a pure lookup (null on miss, never creates)`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  assert.equal(await store.getByThread("nope"), null, "missing thread → null, no session created");
  const s = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));
  const got = await store.getByThread("t1");
  assert.equal(got?.id, s.id);
  assert.equal(await store.getByThread("still-nope"), null);
});

test(`scopeSessionSummaries tags each row with its origin (conversation vs cron)`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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

test(`scopeActivity counts conversations, cron fires and other background per scope`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const dm = await store.getOrCreateByThread("dm:D1", "dm", scope);
  await store.getOrCreateByThread("agent:main:cron:c1", "dm", scope);
  await store.getOrCreateByThread("cron:c1:slot2", "dm", scope);
  await store.getOrCreateByThread("agent:main:webhook:wh1", "dm", scope);
  await store.getOrCreateByThread("dm:D9", "dm", scopeId("personal", "U9"));
  const writer = { sessionId: dm.id };
  await store.append(writer, { kind: "UserMessage", text: "hi" });

  const rows = new Map((await store.scopeActivity()).map((r) => [r.scopeId, r]));
  assert.deepEqual([rows.get(scope)?.conversations, rows.get(scope)?.crons, rows.get(scope)?.background], [1, 2, 1]);
  assert.equal(rows.get(scopeId("personal", "U9"))?.conversations, 1, "every scope gets its own row");
});

test(`overheard catch-up entries are NOT counted as turns or as the first/last message`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("ch:C1:t1", "channel", scope);
  await store.addParticipant(s.id, "U1");
  const writer = { sessionId: s.id };
  await store.append(writer, {
    kind: "UserMessage",
    externalId: "1",
    text: "overheard chatter",
    body: { overheard: true, name: "Alice" },
  });
  await store.append(writer, { kind: "UserMessage", text: "the real question" });
  await store.append(writer, { kind: "AgentMessage", text: "answer" });
  await store.append(writer, {
    kind: "UserMessage",
    externalId: "2",
    text: "more chatter",
    body: { overheard: true, name: "Bob" },
  });

  const rows = await store.scopeSessionSummaries(scope, false, { limit: 500 });
  const row = rows.find((r) => r.id === s.id)!;
  assert.equal(row.turns, 1, "summary turns excludes overheard");
  assert.equal(row.firstMessage, "the real question", "the overheard row is not the first message");
  assert.equal(row.lastMessage, "the real question", "the overheard row is not the last message");
  assert.equal(row.messages, 4, "messages still counts every durable entry, overheard included");
});

test(`scopeSessionSummaries paginates newest-activity-first`, async () => {
  let clock = Date.now() + 1_000_000;
  const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => (clock += 61_000) });
  const scope = scopeId("personal", "U1");
  const a = await store.getOrCreateByThread("dm:A", "dm", scope);
  const b = await store.getOrCreateByThread("dm:B", "dm", scope);
  await store.getOrCreateByThread("dm:C", "dm", scope);
  await store.append({ sessionId: a.id }, { kind: "UserMessage", text: "a" });
  await store.append({ sessionId: b.id }, { kind: "UserMessage", text: "b" });

  const page1 = await store.scopeSessionSummaries(scope, false, { limit: 2 });
  assert.equal(page1.length, 2);
  assert.equal(page1[0]!.id, b.id, "most recent activity first");
  assert.equal(page1[1]!.id, a.id);
  const page2 = await store.scopeSessionSummaries(scope, false, {
    limit: 2,
    before: { lastActivity: page1[1]!.lastActivity, id: page1[1]!.id },
  });
  assert.equal(page2.length, 1, "third session on the next page");
  assert.equal((await store.scopeSessionSummaries(scope, false, { limit: 500 })).length, 3, "a wide page returns all");
});

test(`scopeSessionSummaries filters category before paginating`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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

test(`scopeSessionSummaries filters origin before paginating`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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

test(`cronId page filters one cron's fires`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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

test(`updateTitle sets the session's display title (absent until set)`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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

test(`getOrCreateByThread captures + self-heals the origin channel name`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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

test(`getOrCreateByThread records + backfills the session's surface (§1)`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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

test(`recordLlmRequest is a per-session diagnostics sidecar, apart from the entry log`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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
  assert.equal(rec.usage, null, "usage defaults to null when the provider reported none");
  assert.equal(rec.transport, null, "transport defaults to null when not captured");
  await store.recordLlmRequest(s.id, {
    turnSeq: 0,
    step: 1,
    model: "claude-x",
    scopeLabel: s.scopeId,
    truncated: true,
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

test(`listLlmRequests filters by turnSeq in the store (no load-all-then-filter)`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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
    meta.every((r) => r.promptEnvelope === undefined),
    "bodies omitted",
  );
  assert.ok(
    meta.every((r) => r.model === "claude-x"),
    "metadata retained",
  );
});

test(`bounded participant listing returns recent rows and keeps the unbounded API`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  for (let i = 0; i < 5; i++) {
    const session = await store.getOrCreateByThread(`bounded:${i}`, "dm", scopeId("personal", "bounded-user"));
    await store.addParticipant(session.id, "bounded-user");
  }
  assert.equal((await store.listByParticipant("bounded-user")).length, 5);
  assert.equal((await store.listByParticipant("bounded-user", { limit: 2 })).length, 2);
  assert.equal((await store.listByParticipant("bounded-user", { limit: 0 })).length, 0);
});

test(`listByParticipant powers unified history`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const s1 = await store.getOrCreateByThread("t1", "dm", scopeId("personal", "U1"));
  const s2 = await store.getOrCreateByThread("t2", "channel", scopeId("channel", "C1"));
  await store.addParticipant(s1.id, "U1");
  await store.addParticipant(s2.id, "U1");
  await store.addParticipant(s2.id, "U2");
  assert.equal((await store.listByParticipant("U1")).length, 2);
  assert.equal((await store.listByParticipant("U2")).length, 1);
});

test(`getForParticipant returns exactly the row listByParticipant returns`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  await assertParticipantSessionParity(store, `parity-a`);
  await assertParticipantSessionParity(store, `parity-b`);
});

test(`spendRollup groups model-call cost by UTC day, scope, origin and model`, async () => {
  await assertSpendRollupParity((now) => createPostgresSessionStore(testDatabaseUrl(), { now }), `spend`);
});

test(`countSessions and distinctParticipants aggregate without loading rows`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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
  assert.deepEqual(await store.distinctParticipants(), ["U1"], "one id per current participant");
  await store.deleteSession(b.id);
  assert.equal(await store.countSessions(), 1);
  assert.deepEqual(await store.distinctParticipants(), ["U1"]);
});

test(`deleteSession hard-removes the session and its rows`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("t1", "dm", scope);
  const keep = await store.getOrCreateByThread("t2", "dm", scope);
  await store.addParticipant(s.id, "U1");
  await store.addParticipant(keep.id, "U1");
  const writer = { sessionId: s.id };
  await store.append(writer, { kind: "UserMessage", text: "hi" });

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
  await assert.rejects(
    store.append(writer, { kind: "UserMessage", text: "late" }),
    /foreign key/,
    "no append lands on a deleted session",
  );
  const reborn = await store.getOrCreateByThread("t1", "dm", scope);
  assert.notEqual(reborn.id, s.id, "the thread gets a fresh session");
  const fresh = await store.append({ sessionId: reborn.id }, { kind: "UserMessage", text: "hi" });
  assert.equal(fresh.seq, 0, "the fresh session takes appends");
});

test(`listByParticipant sets lastActivityAt to the most recent user message`, async () => {
  let clock = Date.now() + 1_000_000;
  const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => ++clock });
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
  await store.addParticipant(s.id, "U1");
  const writer = { sessionId: s.id };
  await store.append(writer, { kind: "UserMessage", text: "hi" });
  const lastUser = await store.append(writer, { kind: "UserMessage", text: "still here" });
  await store.append(writer, { kind: "AgentMessage", text: "yo" });
  await store.append(writer, { kind: "ToolCall", tool: "execute", callId: "c1" });

  const row = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
  assert.equal(
    row.lastActivityAt,
    lastUser.createdAt,
    "tracks the last user message, ignoring the agent's later assistant/tool entries",
  );
});

test(`listByParticipant falls back to createdAt for an entry-less session`, async () => {
  let clock = Date.now() + 1_000_000;
  const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => ++clock });
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
  await store.addParticipant(s.id, "U1");

  const row = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
  assert.equal(row.lastActivityAt, s.createdAt, "an entry-less session falls back to its creation time");
});

test(`listByParticipant reports whether the transcript has any entries`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
  await store.addParticipant(s.id, "U1");

  assert.equal((await store.listByParticipant("U1")).find((x) => x.id === s.id)?.hasEntries, false, "no entries yet");

  const writer = { sessionId: s.id };
  await store.append(writer, { kind: "Wake", wakeCause: "system", body: { text: "note" } });

  assert.equal(
    (await store.listByParticipant("U1")).find((x) => x.id === s.id)?.hasEntries,
    true,
    "flips once anything lands",
  );
});

test(`removing a participant clears their view; re-adding starts fresh`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("dm:D1", "dm", scope);
  await store.addParticipant(s.id, "U1");
  await store.updateParticipantView(s.id, "U1", { title: "My name", archived: true, pinned: true, color: "#3b82f6" });

  await store.removeParticipant(s.id, "U1");
  assert.equal(
    (await store.listByParticipant("U1")).some((x) => x.id === s.id),
    false,
  );
  await store.addParticipant(s.id, "U1");

  const row = (await store.listByParticipant("U1")).find((x) => x.id === s.id)!;
  assert.equal(row.title ?? null, null);
  assert.ok(!row.archived);
  assert.ok(!row.pinned);
  assert.equal(row.color ?? null, null);
});

test(`updateParticipantView rename/archive is per-participant`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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

test(`updateParticipantView pin/color is per-participant and clears`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
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

test(`addParticipant can initialize a private title and later replace it`, async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("group", "G1");
  const session = await store.getOrCreateByThread("t1", "group", scope);
  await store.updateTitle(session.id, "Earlier discussion");
  await store.addParticipant(session.id, "U1", "");
  assert.equal((await store.listByParticipant("U1"))[0]?.title, "");

  const writer = { sessionId: session.id };
  await store.append(writer, { kind: "UserMessage", text: "visible" });
  await store.addParticipant(session.id, "U1", "My project chat");
  assert.equal((await store.visibleItems(session.id, "U1")).length, 1);
  assert.equal((await store.listByParticipant("U1"))[0]?.title, "My project chat");
});

test(`keyset cursor pages stitch into the full listing and skip nothing`, async () => {
  let clock = Date.now() + 1_000_000;
  const store = createPostgresSessionStore(testDatabaseUrl(), { now: () => ++clock });
  const scope = scopeId("personal", "U1");
  for (let i = 0; i < 5; i++) {
    const s = await store.getOrCreateByThread(`dm:K${i}`, "dm", scope);
    const writer = { sessionId: s.id };
    await store.append(writer, { kind: "UserMessage", text: `m${i}` });
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

test("getEntry returns exactly the requested seq and nothing else", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("dm:point-fetch", "dm", scope);
  const writer = { sessionId: s.id };
  const first = await store.append(writer, { kind: "UserMessage", text: "one" });
  const second = await store.append(writer, { kind: "AgentMessage", text: "two" });
  assert.deepEqual(await store.getItem(s.id, first.seq), first);
  assert.deepEqual(await store.getItem(s.id, second.seq), second);
  assert.equal(await store.getItem(s.id, second.seq + 1), undefined);
  assert.equal(await store.getItem("missing", 0), undefined);
});

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

test("the store's origin and the admin wake-ref parser agree on which threadRefs are background", () => {
  const refs = [
    "agent:main:cron:abc",
    "agent:main:webhook:wh1",
    "agent:main:monitor:m1",
    "agent:main:cron:abc:extra",
    "agent:main:email:e1",
    "agent:cron:abc",
    "cron:c1:fire:abc",
    "cron:c1:2026-01-01T00:00",
    "cron:c1:manual:uuid",
    "webhook:wh1:delivery",
    "monitor:m1:lost",
    "monitor:m1:quiet:123",
    "cron:",
    "cronx:1",
    "Cron:1",
    " cron:1",
    "ch:cron:1",
    "dm:D1",
    "ch:C1:t1",
    "",
  ];
  for (const ref of refs) {
    assert.equal(
      sessionCategory(sessionOrigin(ref)),
      parseSessionWakeRef(ref) ? "background" : "conversation",
      `classifiers agree on ${JSON.stringify(ref)}`,
    );
  }
});

test("deleteSessionIfEmpty refuses after entries land, and a discarded session takes no appends", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const scope = scopeId("personal", "U1");
  const s = await store.getOrCreateByThread("web:U1:seed", "dm", scope);
  await store.append({ sessionId: s.id }, { kind: "UserMessage", text: "seed" });
  assert.equal(await store.deleteSessionIfEmpty(s.id), false, "entries block the discard");
  const empty = await store.getOrCreateByThread("web:U1:seed2", "dm", scope);
  assert.equal(await store.deleteSessionIfEmpty(empty.id), true, "an empty session is discarded");
  assert.equal(await store.get(empty.id), null);
  await assert.rejects(
    store.append({ sessionId: empty.id }, { kind: "UserMessage" }),
    /foreign key/,
    "a late writer cannot append after the discard",
  );
});
