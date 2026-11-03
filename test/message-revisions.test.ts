import { test } from "node:test";
import assert from "node:assert/strict";
import {
  messageRevision,
  reconcileMessageRevisions,
  recordMessageRevisions,
  renderMessageRevision,
  revisionAnchorAt,
  slackTsToMs,
  type MessageRevisionPayload,
} from "../src/slack/message-revisions.ts";
import { parseSlackThreadRef, slackThreadRefCandidates } from "../src/slack/message-gating.ts";
import { sleep } from "../src/util/async.ts";
import { reconstructMessagesFromHistory } from "../src/agent/replay.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { IngestEvent } from "../src/surface-cache/types.ts";
import type { ScopeId } from "../src/types.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresSurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { holdThread, testRuns } from "./support/live-run.ts";
import { type Item, type NewItem, storedItem } from "../src/sessions/items.ts";

const SCOPE = "personal:alex@example.com" as ScopeId;
const runs = testRuns();
const DM = "D123";
const CH = "C456";

async function seedSession(
  sessions: SessionStore,
  threadRef: string,
  type: "dm" | "channel",
  userPayloads: Array<{ text: string; ts: string; hidden?: boolean } & Record<string, unknown>>,
) {
  const session = await sessions.getOrCreateByThread(threadRef, type, SCOPE, undefined, "slack");
  const writer = { sessionId: session.id };
  for (const { text, ts, hidden, ...body } of userPayloads) {
    const item: NewItem = { kind: "UserMessage", text, externalId: ts, body };
    await sessions.append(writer, hidden === undefined ? item : { ...item, hidden });
  }
  return session;
}

function edit(over: Partial<IngestEvent> = {}): IngestEvent {
  return { container: DM, ts: "100.1", editedAt: Date.now(), text: "fixed text", kind: "dm", ...over };
}

function del(over: Partial<IngestEvent> = {}): IngestEvent {
  return { container: DM, ts: "100.1", deleted: true, ...over };
}

async function history(sessions: SessionStore, sessionId: string): Promise<Item[]> {
  return sessions.getItems(sessionId);
}

function revisions(entries: readonly Item[]): MessageRevisionPayload[] {
  return entries.flatMap((e) => {
    const r = messageRevision(e);
    return r ? [r] : [];
  });
}

test("an edit of a recorded DM message appends one marker entry the model sees", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, runs, [edit()]);

  const entries = await history(sessions, session.id);
  const marks = revisions(entries);
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0], {
    action: "edited",
    ts: "100.1",
    text: "fixed text",
    name: "Alex Morgan",
  });

  assert.match(JSON.stringify(reconstructMessagesFromHistory(entries)), /fixed text/);
});

test("edits and deletions of messages never recorded in the session append nothing", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, runs, [edit({ ts: "999.9" }), del({ ts: "999.9" })]);
  await recordMessageRevisions(sessions, runs, [edit({ container: "D999" })]);

  assert.equal(revisions(await history(sessions, session.id)).length, 0);
});

test("repeated edit events with the same text dedupe to one marker; a real re-edit appends another", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, runs, [edit()]);
  await recordMessageRevisions(sessions, runs, [edit()]);
  assert.equal(revisions(await history(sessions, session.id)).length, 1);

  await recordMessageRevisions(sessions, runs, [edit({ text: "fixed again" })]);
  const marks = revisions(await history(sessions, session.id));
  assert.equal(marks.length, 2);
  assert.equal(marks[1]!.text, "fixed again");
});

test("an unfurl-style edit event carrying the unchanged original text is a no-op", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, runs, [edit({ text: "original text" })]);
  assert.equal(revisions(await history(sessions, session.id)).length, 0);
});

test("an edit back to the original text after a real edit is recorded", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, runs, [edit()]);
  await recordMessageRevisions(sessions, runs, [edit({ text: "original text" })]);
  const marks = revisions(await history(sessions, session.id));
  assert.equal(marks.length, 2);
  assert.equal(marks[1]!.text, "original text");
});

test("a deletion after an edit appends a second marker; repeated deletions dedupe", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
  ]);

  await recordMessageRevisions(sessions, runs, [edit()]);
  await recordMessageRevisions(sessions, runs, [del()]);
  await recordMessageRevisions(sessions, runs, [del()]);
  const marks = revisions(await history(sessions, session.id));
  assert.deepEqual(
    marks.map((m) => m.action),
    ["edited", "deleted"],
  );
});

test("self events and hidden originals are left alone", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { text: "original text", ts: "100.1", name: "Alex Morgan" },
    { text: "hidden", ts: "100.2", hidden: true },
  ]);

  await recordMessageRevisions(sessions, runs, [edit({ self: true }), edit({ ts: "100.2", text: "revealed" })]);
  assert.equal(revisions(await history(sessions, session.id)).length, 0);
});

test("a channel thread reply's edit reaches the thread session via the sub root", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `ch:${CH}:50.0`, "channel", [
    { text: "reply text", ts: "51.0", name: "Josh" },
  ]);

  await recordMessageRevisions(sessions, runs, [
    { container: CH, ts: "51.0", sub: "50.0", editedAt: Date.now(), text: "reply fixed", kind: "channel" },
  ]);
  const marks = revisions(await history(sessions, session.id));
  assert.equal(marks.length, 1);
  assert.equal(marks[0]!.name, "Josh");
});

test("the marker renders into model context on the entries-replay path", () => {
  const at = (seq: number) => ({ sessionId: "s", seq, createdAt: seq });
  const history: Item[] = [
    storedItem({ kind: "UserMessage", text: "original text", externalId: "100.1" }, at(1)),
    storedItem(
      { kind: "Retraction", body: { action: "edited", ts: "100.1", text: "fixed <text>", name: "Alex Morgan" } },
      at(2),
    ),
    storedItem({ kind: "Retraction", body: { action: "deleted", ts: "100.1", name: "Alex Morgan" } }, at(3)),
  ];
  const messages = reconstructMessagesFromHistory(history);
  const texts = messages.map((m) => (m.content[0] as { text: string }).text);
  assert.equal(texts[0], "── Wednesday, December 31, 1969 ──\noriginal text");
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

test("while a turn is live the ingest-time marker is skipped, and the turn-end catch-up records it", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  const session = await seedSession(sessions, `ch:${CH}:50.0`, "channel", [
    { text: "original text", ts: "50.0", name: "Alex Morgan" },
    { text: "second", ts: "51.0", name: "Ada" },
  ]);
  const anchorAt = (await sessions.getItem(session.id, await sessions.latestItemSeq(session.id)))!.createdAt;
  await sleep(5);
  const writer = { sessionId: session.id };
  const finishTurn = await holdThread(runs, session.threadRef);

  await cache.ingest([{ container: CH, ts: "50.0", text: "original text", createdAt: 1 }]);
  await cache.ingest([{ container: CH, ts: "51.0", text: "second", sub: "50.0", createdAt: 2 }]);
  await cache.ingest([{ container: CH, ts: "60.0", text: "elsewhere", createdAt: 3 }]);
  const events = [
    edit({ container: CH, ts: "50.0", text: "fixed text" }),
    del({ container: CH, ts: "51.0", sub: "50.0" }),
    edit({ container: CH, ts: "60.0", text: "elsewhere edited" }),
  ];
  await cache.ingest(events);
  await recordMessageRevisions(sessions, runs, events, NO_WAIT);
  assert.equal(revisions(await history(sessions, session.id)).length, 0, "a busy session records nothing yet");

  const recorded = await reconcileMessageRevisions({
    sessions,
    surfaceCache: cache,
    writer,
    session: { id: session.id, threadRef: session.threadRef },
    anchorAt,
    fallbackSince: 0,
  });
  assert.equal(recorded, 2, "only the thread's own messages are marked; the other thread's edit is not this session's");
  const marks = revisions(await history(sessions, session.id)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  assert.deepEqual(
    marks.map((m) => [m.action, m.ts, m.text ?? null]),
    [
      ["edited", "50.0", "fixed text"],
      ["deleted", "51.0", null],
    ],
  );

  const again = await reconcileMessageRevisions({
    sessions,
    surfaceCache: cache,
    writer,
    session: { id: session.id, threadRef: session.threadRef },
    anchorAt,
    fallbackSince: 0,
  });
  assert.equal(again, 0, "the catch-up is idempotent");
  await finishTurn();
});

test("the catch-up ignores the bot's own edits and non-Slack sessions", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [{ text: "original text", ts: "100.1" }]);
  await cache.ingest([{ container: DM, ts: "100.1", text: "self edit", editedAt: Date.now(), self: true }]);
  const writer = { sessionId: session.id };
  const target = { id: session.id, threadRef: session.threadRef };
  assert.equal(
    await reconcileMessageRevisions({
      sessions,
      surfaceCache: cache,
      writer,
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
      writer,
      session: { ...target, threadRef: "web:alice:conv" },
      anchorAt: undefined,
      fallbackSince: 0,
    }),
    0,
  );
});

test("an edit whose marker is already recorded never checks for a live turn", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [{ text: "original text", ts: "100.1" }]);
  await recordMessageRevisions(sessions, runs, [edit()], NO_WAIT);
  const checks: string[] = [];
  const spied = {
    inFlightForThread: async (threadRef: string) => {
      checks.push(threadRef);
      return runs.inFlightForThread(threadRef);
    },
  };
  await recordMessageRevisions(sessions, spied, [edit()], NO_WAIT);
  assert.deepEqual(checks, [], "a no-op revision is decided from a plain read");
  assert.equal(revisions(await history(sessions, session.id)).length, 1);
});

test("the anchor is the last conversation entry, skipping system entries such as a fresh marker", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [{ text: "original text", ts: "100.1" }]);
  const conversationAt = (await history(sessions, session.id)).at(-1)!.createdAt;
  await sleep(5);
  await recordMessageRevisions(sessions, runs, [edit()], NO_WAIT);
  const writer = { sessionId: session.id };
  await sessions.append(writer, { kind: "Wake", wakeCause: "cron", body: { text: "a fresh marker" } });
  assert.equal(await revisionAnchorAt(sessions, session.id), conversationAt);
  assert.equal(await revisionAnchorAt(createPostgresSessionStore(testDatabaseUrl()), "nope"), undefined);
});

test("an edit made before the message's own turn is still caught through the trigger timestamp", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const cache = createPostgresSurfaceCache(testDatabaseUrl());
  const session = await seedSession(sessions, `ch:${CH}:50.0`, "channel", [{ text: "first", ts: "50.0" }]);
  const editedAt = Date.now() - 60_000;
  await cache.ingest([{ container: CH, ts: "51.0", sub: "50.0", text: "secnd", createdAt: editedAt - 1 }]);
  await cache.ingest([{ container: CH, ts: "51.0", sub: "50.0", text: "second", editedAt }]);
  const writer = { sessionId: session.id };
  await sessions.append(writer, { kind: "UserMessage", text: "secnd", externalId: "51.0" });
  const anchorAt = Date.now();
  const target = { id: session.id, threadRef: session.threadRef };
  assert.equal(
    await reconcileMessageRevisions({
      sessions,
      surfaceCache: cache,
      writer,
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
      writer,
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
});

test("imported agent posts receive attributed edits and deletions without creating assistant actions", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await seedSession(sessions, `dm:${DM}`, "dm", [
    { overheard: true, sourceRole: "agent", text: "Shall I restart it?", ts: "100.1" },
  ]);
  await recordMessageRevisions(sessions, runs, [edit({ self: true, text: "Shall I restart the worker?" })]);
  await recordMessageRevisions(sessions, runs, [del({ self: true })]);
  const entries = await history(sessions, session.id);
  const marks = revisions(entries);
  assert.deepEqual(
    marks.map((m) => [m.action, m.sourceRole]),
    [
      ["edited", "agent"],
      ["deleted", "agent"],
    ],
  );
  assert.match(renderMessageRevision(marks[0]!), /from="agent"/);
  assert.equal(
    reconstructMessagesFromHistory(entries).some((m) => m.role === "assistant"),
    false,
  );
});
