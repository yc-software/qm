import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import {
  messageRevision,
  reconcileMessageRevisions,
  recordMessageRevisions,
  renderMessageRevision,
  revisionAnchorAt,
  slackTsToMs,
  type MessageRevisionPayload,
} from "../src/core/message-revisions.ts";
import { parseSlackThreadRef, slackThreadRefCandidates } from "../src/slack/message-gating.ts";
import { sleep } from "../src/util/async.ts";
import { createMemorySurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { reconstructMessagesFromHistory } from "../src/harness/replay.ts";
import { projectTapeEntries } from "../src/harness/tape-projection.ts";
import { tapeCheckpointPayload, type SessionStore } from "../src/sessions/session-store.ts";
import type { IngestEvent } from "../src/surface-cache/types.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

const SCOPE = "personal:alex@example.com" as ScopeId;
const DM = "D123";
const CH = "C456";

async function seedSession(
  sessions: SessionStore,
  threadRef: string,
  type: "dm" | "channel",
  userPayloads: Array<Record<string, unknown>>,
) {
  const session = await sessions.getOrCreateByThread(threadRef, type, SCOPE, undefined, "slack");
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);
  let lastSeq = -1;
  for (const payload of userPayloads) {
    const appended = await sessions.append(lease!, { type: "user", payload, scopeLabel: SCOPE });
    await sessions.appendTape(lease!, {
      kind: "message",
      payload: { role: "user", content: [{ type: "text", text: String(payload.text) }], timestamp: appended.createdAt },
      scopeLabel: SCOPE,
      meta: { bareText: String(payload.text), entryCreatedAt: appended.createdAt },
      entrySeq: appended.seq,
    });
    lastSeq = appended.seq;
  }
  await sessions.appendTape(lease!, {
    kind: "annotation",
    payload: tapeCheckpointPayload("turnEnd"),
    scopeLabel: SCOPE,
    entrySeq: lastSeq,
  });
  await sessions.releaseLease(lease!);
  return session;
}

function edit(over: Partial<IngestEvent> = {}): IngestEvent {
  return { container: DM, ts: "100.1", editedAt: Date.now(), text: "fixed text", kind: "dm", ...over };
}

function del(over: Partial<IngestEvent> = {}): IngestEvent {
  return { container: DM, ts: "100.1", deleted: true, ...over };
}

function revisions(entries: readonly SessionEntry[]): MessageRevisionPayload[] {
  return entries.flatMap((e) => {
    const r = messageRevision(e);
    return r ? [r] : [];
  });
}

test("an edit of a recorded DM message appends one marker entry and mirrors it onto the tape", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, [edit()]);

  const entries = await sessions.getEntries(session.id);
  const marks = revisions(entries);
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0], {
    kind: "message_revision",
    action: "edited",
    ts: "100.1",
    text: "fixed text",
    name: "Alex Morgan",
  });

  const tape = await sessions.getTape(session.id);
  const messageRow = tape.find(
    (row) => row.kind === "message" && JSON.stringify(row.payload).includes("message-edited"),
  );
  assert.ok(messageRow, "a user-voice tape message row carries the marker for the model");
  const bound = tape.find((row) => {
    const p = row.payload as { turnEnd?: unknown; entry?: { payload?: { kind?: unknown } } } | null;
    return row.kind === "annotation" && p?.turnEnd === true && p.entry?.payload?.kind === "message_revision";
  });
  assert.ok(bound, "a turnEnd annotation keeps the tape projection covering the marker entry");
  assert.equal(await sessions.tapeCoverage(session.id), await sessions.latestEntrySeq(session.id));

  const projection = projectTapeEntries(session.id, tape);
  assert.ok(projection, "the tape stays projectable after the marker lands");
  const projected = projection!.entries.flatMap((e) => {
    const r = messageRevision(e);
    return r ? [r] : [];
  });
  assert.equal(projected.length, 1, "the projected transcript carries the marker entry");
});

test("edits and deletions of messages never recorded in the session append nothing", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, [edit({ ts: "999.9" }), del({ ts: "999.9" })]);
  await recordMessageRevisions(sessions, [edit({ container: "D999" })]);

  assert.equal(revisions(await sessions.getEntries(session.id)).length, 0);
});

test("repeated edit events with the same text dedupe to one marker; a real re-edit appends another", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, [edit()]);
  await recordMessageRevisions(sessions, [edit()]);
  assert.equal(revisions(await sessions.getEntries(session.id)).length, 1);

  await recordMessageRevisions(sessions, [edit({ text: "fixed again" })]);
  const marks = revisions(await sessions.getEntries(session.id));
  assert.equal(marks.length, 2);
  assert.equal(marks[1]!.text, "fixed again");
});

test("an unfurl-style edit event carrying the unchanged original text is a no-op", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, [edit({ text: "original text" })]);
  assert.equal(revisions(await sessions.getEntries(session.id)).length, 0);
});

test("an edit back to the original text after a real edit is recorded", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, [edit()]);
  await recordMessageRevisions(sessions, [edit({ text: "original text" })]);
  const marks = revisions(await sessions.getEntries(session.id));
  assert.equal(marks.length, 2);
  assert.equal(marks[1]!.text, "original text");
});

test("a deletion after an edit appends a second marker; repeated deletions dedupe", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, [edit()]);
  await recordMessageRevisions(sessions, [del()]);
  await recordMessageRevisions(sessions, [del()]);
  const marks = revisions(await sessions.getEntries(session.id));
  assert.deepEqual(
    marks.map((m) => m.action),
    ["edited", "deleted"],
  );
});

test("self events and hidden or quarantined originals are left alone", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
    { text: "quarantined", ts: "100.2", securityTainted: true, hidden: true },
  ]);

  await recordMessageRevisions(sessions, [edit({ self: true }), edit({ ts: "100.2", text: "revealed" })]);
  assert.equal(revisions(await sessions.getEntries(session.id)).length, 0);
});

test("a channel thread reply's edit reaches the thread session via the sub root", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `ch:${CH}:50.0`, "channel", [
    { text: "reply text", ts: "51.0", name: "Josh" },
  ]);

  await recordMessageRevisions(sessions, [
    { container: CH, ts: "51.0", sub: "50.0", editedAt: Date.now(), text: "reply fixed", kind: "channel" },
  ]);
  const marks = revisions(await sessions.getEntries(session.id));
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.name, "Josh");
});

test("when the tape is not contiguous the marker entry still lands but the tape stays untouched", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread(`dm:${DM}`, "dm", SCOPE, undefined, "slack");
  const { lease } = await sessions.acquireLease(session.id, "turn");
  await sessions.append(lease!, { type: "user", payload: { text: "original text", ts: "100.1" }, scopeLabel: SCOPE });
  await sessions.releaseLease(lease!);

  await recordMessageRevisions(sessions, [edit()]);

  assert.equal(revisions(await sessions.getEntries(session.id)).length, 1);
  assert.equal((await sessions.getTape(session.id)).length, 0);
});

test("the marker renders into model context on the entries-replay path", () => {
  const history = [
    { type: "user", payload: { text: "original text", ts: "100.1" }, createdAt: 1, seq: 1, parentSeq: null },
    {
      type: "system",
      payload: { kind: "message_revision", action: "edited", ts: "100.1", text: "fixed <text>", name: "Alex Morgan" },
      createdAt: 2,
      seq: 2,
      parentSeq: null,
    },
    {
      type: "system",
      payload: { kind: "message_revision", action: "deleted", ts: "100.1", name: "Alex Morgan" },
      createdAt: 3,
      seq: 3,
      parentSeq: null,
    },
  ] as unknown as SessionEntry[];
  const messages = reconstructMessagesFromHistory(history);
  assert.equal(messages.length, 1, "consecutive user-voice messages merge");
  const texts = messages[0]!.content.map((c) => (c as { text: string }).text);
  assert.equal(texts[0], "original text");
  assert.match(texts[1]!, /<message-edited id="100.1" author="Alex Morgan"[^>]*>fixed &lt;text&gt;<\/message-edited>/);
  assert.match(
    texts[2]!,
    /<message-deleted id="100.1" author="Alex Morgan"[^>]*>the author deleted this message<\/message-deleted>/,
  );
});

test("revision thread-ref candidates cover DM, DM thread, channel, and group roots", () => {
  assert.deepEqual(slackThreadRefCandidates("C1", "10.0"), ["dm:C1", "dm:C1:10.0", "ch:C1:10.0", "grp:C1:10.0"]);
  assert.deepEqual(slackThreadRefCandidates("C1", "11.0", "10.0"), [
    "dm:C1",
    "dm:C1:10.0",
    "ch:C1:10.0",
    "grp:C1:10.0",
  ]);
  assert.deepEqual(parseSlackThreadRef("ch:C1:10.0"), { container: "C1", root: "10.0" });
  assert.deepEqual(parseSlackThreadRef("dm:D9"), { container: "D9" });
  assert.deepEqual(parseSlackThreadRef("grp:G2:7.7"), { container: "G2", root: "7.7" });
  assert.equal(parseSlackThreadRef("web:alice:conv"), null);
});

test("renderMessageRevision escapes attribute and body text", () => {
  const rendered = renderMessageRevision({
    kind: "message_revision",
    action: "edited",
    ts: '10.0" evil',
    text: "<b>&",
    name: 'A"B',
  });
  assert.match(rendered, /id="10.0&quot; evil"/);
  assert.match(rendered, /author="A&quot;B"/);
  assert.match(rendered, />&lt;b&gt;&amp;</);
});

const NO_WAIT = { attempts: 1, retryMs: 0 };

test("while a turn holds the lease the ingest-time marker is skipped, and the turn-end catch-up records it", async () => {
  const sessions = createMemorySessionStore();
  const cache = createMemorySurfaceCache();
  const session = await seedSession(sessions, `ch:${CH}:50.0`, "channel", [
    { text: "original text", ts: "50.0", name: "Alex Morgan" },
    { text: "second", ts: "51.0", name: "Ada" },
  ]);
  const anchorAt = (await sessions.getEntry(session.id, await sessions.latestEntrySeq(session.id)))!.createdAt;
  await sleep(5);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  assert.ok(lease);

  await cache.ingest([{ container: CH, ts: "50.0", text: "original text", createdAt: 1 }]);
  await cache.ingest([{ container: CH, ts: "51.0", text: "second", sub: "50.0", createdAt: 2 }]);
  await cache.ingest([{ container: CH, ts: "60.0", text: "elsewhere", createdAt: 3 }]);
  const events = [
    edit({ container: CH, ts: "50.0", text: "fixed text" }),
    del({ container: CH, ts: "51.0", sub: "50.0" }),
    edit({ container: CH, ts: "60.0", text: "elsewhere edited" }),
  ];
  await cache.ingest(events);
  await recordMessageRevisions(sessions, events, NO_WAIT);
  assert.equal(revisions(await sessions.getEntries(session.id)).length, 0, "a busy session records nothing yet");

  const recorded = await reconcileMessageRevisions({
    sessions,
    surfaceCache: cache,
    lease: lease!,
    session: { id: session.id, scopeId: SCOPE, threadRef: session.threadRef },
    anchorAt,
    fallbackSince: 0,
  });
  assert.equal(recorded, 2, "only the thread's own messages are marked; the other thread's edit is not this session's");
  const marks = revisions(await sessions.getEntries(session.id)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  assert.deepEqual(
    marks.map((m) => [m.action, m.ts, m.text ?? null]),
    [
      ["edited", "50.0", "fixed text"],
      ["deleted", "51.0", null],
    ],
  );
  assert.equal(await sessions.tapeCoverage(session.id), await sessions.latestEntrySeq(session.id));

  const again = await reconcileMessageRevisions({
    sessions,
    surfaceCache: cache,
    lease: lease!,
    session: { id: session.id, scopeId: SCOPE, threadRef: session.threadRef },
    anchorAt,
    fallbackSince: 0,
  });
  assert.equal(again, 0, "the catch-up is idempotent");
  await sessions.releaseLease(lease!);
});

test("the catch-up ignores the bot's own edits and non-Slack sessions", async () => {
  const sessions = createMemorySessionStore();
  const cache = createMemorySurfaceCache();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [{ text: "original text", ts: "100.1" }]);
  await cache.ingest([{ container: DM, ts: "100.1", text: "self edit", editedAt: Date.now(), self: true }]);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  const target = { id: session.id, scopeId: SCOPE, threadRef: session.threadRef };
  assert.equal(
    await reconcileMessageRevisions({
      sessions,
      surfaceCache: cache,
      lease: lease!,
      session: target,
      anchorAt: undefined,
      fallbackSince: 0,
    }),
    0,
  );
  assert.equal(
    await reconcileMessageRevisions({
      sessions,
      surfaceCache: cache,
      lease: lease!,
      session: { ...target, threadRef: "web:alice:conv" },
      anchorAt: undefined,
      fallbackSince: 0,
    }),
    0,
  );
  await sessions.releaseLease(lease!);
});

test("an edit whose marker is already recorded never takes the backfill lease", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [{ text: "original text", ts: "100.1" }]);
  await recordMessageRevisions(sessions, [edit()], NO_WAIT);
  const acquires: string[] = [];
  const spied = {
    ...sessions,
    acquireLease: async (id: string, holder?: "turn" | "compaction" | "fork" | "backfill") => {
      acquires.push(holder ?? "");
      return sessions.acquireLease(id, holder);
    },
  };
  await recordMessageRevisions(spied, [edit()], NO_WAIT);
  assert.deepEqual(acquires, [], "a no-op revision is decided from a plain read");
  assert.equal(revisions(await sessions.getEntries(session.id)).length, 1);
});

test("the anchor is the last conversation entry, skipping system entries such as a fresh marker", async () => {
  const sessions = createMemorySessionStore();
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [{ text: "original text", ts: "100.1" }]);
  const conversationAt = (await sessions.getEntries(session.id)).at(-1)!.createdAt;
  await sleep(5);
  await recordMessageRevisions(sessions, [edit()], NO_WAIT);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  await sessions.append(lease!, { type: "system", payload: { kind: "note" }, scopeLabel: SCOPE });
  await sessions.releaseLease(lease!);
  assert.equal(await revisionAnchorAt(sessions, session.id), conversationAt);
  assert.equal(await revisionAnchorAt(createMemorySessionStore(), "nope"), undefined);
});

test("an edit made before the message's own turn is still caught through the trigger timestamp", async () => {
  const sessions = createMemorySessionStore();
  const cache = createMemorySurfaceCache();
  const session = await seedSession(sessions, `ch:${CH}:50.0`, "channel", [{ text: "first", ts: "50.0" }]);
  const editedAt = Date.now() - 60_000;
  await cache.ingest([{ container: CH, ts: "51.0", sub: "50.0", text: "secnd", createdAt: editedAt - 1 }]);
  await cache.ingest([{ container: CH, ts: "51.0", sub: "50.0", text: "second", editedAt }]);
  const { lease } = await sessions.acquireLease(session.id, "turn");
  await sessions.append(lease!, { type: "user", payload: { text: "secnd", ts: "51.0" }, scopeLabel: SCOPE });
  const anchorAt = Date.now();
  const target = { id: session.id, scopeId: SCOPE, threadRef: session.threadRef };
  assert.equal(
    await reconcileMessageRevisions({
      sessions,
      surfaceCache: cache,
      lease: lease!,
      session: target,
      anchorAt,
      fallbackSince: anchorAt,
    }),
    0,
    "the anchor alone is after the edit",
  );
  assert.equal(
    await reconcileMessageRevisions({
      sessions,
      surfaceCache: cache,
      lease: lease!,
      session: target,
      anchorAt,
      fallbackSince: anchorAt,
      triggerTs: String((editedAt - 1) / 1000),
    }),
    1,
    "the turn's own message widens the window back to its send time",
  );
  assert.equal(slackTsToMs("1700000000.123456"), 1700000000123);
  assert.equal(slackTsToMs("t1"), undefined);
  await sessions.releaseLease(lease!);
});
