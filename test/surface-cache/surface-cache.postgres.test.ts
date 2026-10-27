import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSurfaceCache } from "../../src/surface-cache/surface-cache.ts";
import { createPostgresChannelPolicyStore } from "../../src/surface-cache/channel-policy-store.ts";
import { truncateTables } from "../support/test-database.ts";

const URL = process.env.DATABASE_URL!;

before(async () => {
  await truncateTables(URL, [
    "channel_messages",
    "channel_state",
    "channel_files",
    "channel_policy",
    "channel_policy_history",
  ]);
});

test("pg surface-cache: upsert idempotency + last-writer-wins on change-time", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    await cache.ingest([{ container: "C1", ts: "1.0", authorId: "U1", text: "original", createdAt: 1 }]);
    await cache.ingest([{ container: "C1", ts: "1.0", authorId: "U1", text: "original", createdAt: 1 }]);
    let msgs = await cache.readMessages("C1");
    assert.equal(msgs.length, 1, "the same ts stays one row");
    await cache.ingest([{ container: "C1", ts: "1.0", text: "edited", editedAt: 5, createdAt: 1 }]);
    msgs = await cache.readMessages("C1");
    assert.equal(msgs[0]!.text, "edited", "the edit wins");
    await cache.ingest([{ container: "C1", ts: "1.0", text: "original", createdAt: 1 }]);
    msgs = await cache.readMessages("C1");
    assert.equal(msgs[0]!.text, "edited", "a stale original does not clobber the newer edit");
  } finally {
    await cache.close();
  }
});

test("pg surface-cache: listContainers returns every container unless the caller pages", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    const containers = Array.from({ length: 520 }, (_, i) => `WIDE${i}`);
    await cache.ingest(containers.map((container, i) => ({ container, ts: "1.0", text: "hi", createdAt: i + 1 })));
    const all = await cache.listContainers();
    assert.equal(containers.filter((c) => all.some((row) => row.container === c)).length, 520);
    assert.equal((await cache.listContainers({ limit: 7 })).length, 7);
  } finally {
    await cache.close();
  }
});

test("pg surface-cache: markHandled sets + survives a later ingest (edit) of the same ts", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    await cache.markHandled("CH1", "9.0");
    let msgs = await cache.readMessages("CH1", { noFallback: true });
    assert.equal(msgs[0]?.handled, true, "markHandled upserts a handled row even before ingest");

    await cache.ingest([{ container: "CH1", ts: "9.0", authorId: "U1", text: "the real body", createdAt: 1 }]);
    msgs = await cache.readMessages("CH1", { noFallback: true });
    assert.equal(msgs[0]!.text, "the real body", "ingest fills the body");
    assert.equal(msgs[0]!.handled, true, "ingest never clears handled");

    await cache.ingest([{ container: "CH2", ts: "1.0", text: "hi", createdAt: 1 }]);
    await cache.markHandled("CH2", "1.0");
    const c2 = await cache.readMessages("CH2", { noFallback: true });
    assert.equal(c2[0]!.handled, true, "markHandled flips an existing row");
    await cache.ingest([{ container: "CH2", ts: "1.0", text: "edited", editedAt: 5, createdAt: 1 }]);
    const c2b = await cache.readMessages("CH2", { noFallback: true });
    assert.equal(c2b[0]!.text, "edited", "the edit re-ingests the new text");
    assert.equal(c2b[0]!.handled, true, "an edit keeps handled set");

    await cache.ingest([{ container: "CH3", ts: "1.0", text: "thread follow", handled: true, createdAt: 1 }]);
    const c3 = await cache.readMessages("CH3", { noFallback: true });
    assert.equal(c3[0]!.text, "thread follow", "born-handled ingest still writes the body");
    assert.equal(c3[0]!.handled, true, "handled:true at ingest is stored");
    await cache.ingest([{ container: "CH3", ts: "1.0", text: "thread follow", createdAt: 1 }]);
    const c3b = await cache.readMessages("CH3", { noFallback: true });
    assert.equal(c3b[0]!.handled, true, "a later plain re-ingest never clears born-handled");
  } finally {
    await cache.close();
  }
});

test("pg surface-cache: tsvector search + membership", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    await cache.ingest([
      {
        container: "CS1",
        ts: "1.0",
        text: "the Q3 launch shipped",
        members: ["U1", "U2"],
        containerName: "launch",
        kind: "channel",
        createdAt: 1,
      },
      { container: "CS1", ts: "2.0", sub: "T1", text: "a thread reply about the launch", createdAt: 2 },
      { container: "CS1", ts: "3.0", text: "unrelated chatter", createdAt: 3 },
      { container: "CS1", ts: "4.0", text: "deleted launch note", deleted: true, createdAt: 4 },
    ]);
    const hits = await cache.search("launch");
    assert.ok(hits.length >= 2, "tsvector matches the two live 'launch' messages");
    assert.ok(!hits.some((h) => h.deleted), "the deleted row is excluded from search");
    assert.deepEqual((await cache.members("CS1")).sort(), ["U1", "U2"]);
    assert.equal(await cache.isMember("CS1", "U1"), true);
    assert.equal(await cache.isMember("CS1", "U9"), false);
    const st = await cache.containerState("CS1");
    assert.equal(st?.name, "launch");
    assert.equal(st?.kind, "channel", "the container kind round-trips through the store");
    assert.equal(st?.lastTs, "4.0");
    assert.equal((await cache.listContainers()).find((c) => c.container === "CS1")?.kind, "channel");
  } finally {
    await cache.close();
  }
});

test("pg surface-cache: oldest_ts is the numeric floor (ts::numeric compare, not lexical)", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    await cache.ingest([{ container: "CF1", ts: "1000.1", text: "newest", createdAt: 3 }]);
    await cache.ingest([{ container: "CF1", ts: "999.1", text: "older", createdAt: 2 }]);
    await cache.ingest([{ container: "CF1", ts: "1500.1", text: "even newer", createdAt: 4 }]);
    const st = await cache.containerState("CF1");
    assert.equal(st?.oldestTs, "999.1", "the coverage floor is the numerically-smallest ts");
  } finally {
    await cache.close();
  }
});

test("pg surface-cache: one ingest batch folds container state and keeps the last file list", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    await cache.ingest([
      { container: "CB1", ts: "1000.1", text: "a", createdAt: 1, containerName: "general", kind: "channel" },
      { container: "CB1", ts: "999.1", text: "b", createdAt: 2, files: [{ fileId: "F1", name: "one.txt" }] },
      {
        container: "CB1",
        ts: "999.1",
        text: "b2",
        editedAt: 5,
        createdAt: 2,
        files: [{ fileId: "F2", name: "two.txt" }],
      },
      { container: "CB2", ts: "5.0", text: "other", createdAt: 3 },
    ]);
    const st = await cache.containerState("CB1");
    assert.equal(st?.oldestTs, "999.1");
    assert.equal(st?.lastTs, "999.1", "last_ts keeps the text-wise greatest ts, as GREATEST always did");
    assert.equal(st?.name, "general", "a later event without a name keeps the earlier one");
    const msgs = await cache.readMessages("CB1", { noFallback: true });
    const edited = msgs.find((m) => m.ts === "999.1")!;
    assert.equal(edited.text, "b2");
    assert.deepEqual(
      edited.files?.map((f) => f.fileId),
      ["F2"],
      "the later accepted event replaces the message's files",
    );
    assert.equal((await cache.containerState("CB2"))?.lastTs, "5.0");
  } finally {
    await cache.close();
  }
});

test("pg channel-policy: set + get + list", async () => {
  const store = createPostgresChannelPolicyStore(URL);
  try {
    await store.set("C1", { setBy: "U-admin", bots: { news: { mode: "ignore" } } });
    const p = await store.get("C1");
    assert.deepEqual(p?.bots, { news: { mode: "ignore" } });
    assert.equal(p?.setBy, "U-admin");
    await store.set("C1", { bots: { news: { mode: "user" } } });
    assert.deepEqual((await store.get("C1"))?.bots, { news: { mode: "user" } });
    await store.set("C1", {});
    assert.deepEqual((await store.get("C1"))?.bots, { news: { mode: "user" } }, "omitted bots are kept");
    assert.equal((await store.list()).length, 1);
  } finally {
    await store.close();
  }
});

test("pg channel-policy: ambientEnabled tri-state — unset default, round-trip, omitted preserved, null clears", async () => {
  const store = createPostgresChannelPolicyStore(URL);
  try {
    await store.set("CPA1", { setBy: "U-admin" });
    assert.equal((await store.get("CPA1"))?.ambientEnabled, undefined, "unset by default");
    await store.set("CPA1", { setBy: "U-admin", ambientEnabled: false });
    assert.equal((await store.get("CPA1"))?.ambientEnabled, false);
    await store.set("CPA1", {});
    assert.equal((await store.get("CPA1"))?.ambientEnabled, false, "omitted arg leaves the override unchanged");
    await store.set("CPA1", { ambientEnabled: null });
    assert.equal((await store.get("CPA1"))?.ambientEnabled, undefined, "null clears back to the default rule");
    const h = await store.history("CPA1");
    assert.deepEqual(
      h.map((r) => r.ambientEnabled),
      [undefined, false, false, undefined].reverse(),
      "revisions record the override",
    );
  } finally {
    await store.close();
  }
});

test("pg channel-policy: history appends a revision per set with provenance", async () => {
  const store = createPostgresChannelPolicyStore(URL);
  try {
    await store.set("CPH1", { setBy: "U-alice", sessionId: "sess-1", ambientEnabled: true });
    await store.set("CPH1", {
      setBy: "U-bob",
      sessionId: "sess-2",
      bots: { news: { mode: "rollup", rollupHours: 6 } },
    });
    const h = await store.history("CPH1");
    assert.equal(h.length, 2);
    assert.deepEqual(h[0]?.bots, { news: { mode: "rollup", rollupHours: 6 } });
    assert.equal(h[0]?.setBy, "U-bob");
    assert.equal(h[0]?.sessionId, "sess-2");
    assert.equal(h[1]?.setBy, "U-alice");
  } finally {
    await store.close();
  }
});

test("pg surface-cache: mentions JSONB round-trips and survives a mention-less edit", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    await cache.ingest([
      { container: "Cm", ts: "9.0", text: "hi @jordan", mentions: { U1: "jordan", U2: "avery" }, createdAt: 1 },
    ]);
    let msgs = await cache.readMessages("Cm");
    assert.deepEqual(msgs[0]!.mentions, { U1: "jordan", U2: "avery" });
    await cache.ingest([{ container: "Cm", ts: "9.0", text: "hi @jordan edited", editedAt: 5, createdAt: 1 }]);
    msgs = await cache.readMessages("Cm");
    assert.deepEqual(msgs[0]!.mentions, { U1: "jordan", U2: "avery" }, "a mention-less edit keeps the prior mentions");
  } finally {
    await cache.close();
  }
});

test("pg surface-cache: revisedSince returns edits and deletions after the watermark", async () => {
  const cache = createPostgresSurfaceCache(URL);
  const container = `Crev-${Date.now()}`;
  try {
    await cache.ingest([
      { container, ts: "1.0", text: "a", createdAt: 1 },
      { container, ts: "2.0", text: "b", createdAt: 2 },
      { container, ts: "3.0", text: "c", createdAt: 3 },
    ]);
    const before = Date.now();
    await cache.ingest([{ container, ts: "1.0", text: "a2", editedAt: before + 10 }]);
    await cache.ingest([{ container, ts: "2.0", deleted: true }]);
    const revised = (await cache.revisedSince(container, before - 1)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    assert.deepEqual(
      revised.map((m) => [m.ts, m.text, m.deleted ?? false]),
      [
        ["1.0", "a2", false],
        ["2.0", "b", true],
      ],
    );
    assert.ok((revised.find((m) => m.ts === "2.0")!.deletedAt ?? 0) >= before);
    assert.ok(
      (await cache.revisedSince(container, before + 10)).some((m) => m.ts === "1.0"),
      "the watermark itself is included",
    );
    assert.ok(!(await cache.revisedSince(container, before + 11)).some((m) => m.ts === "1.0"));
  } finally {
    await cache.close();
  }
});

test("pg surface-cache: revisedSince returns every revision after the watermark, however many there are", async () => {
  const cache = createPostgresSurfaceCache(URL);
  const container = `Cmany-${Date.now()}`;
  const count = 1200;
  try {
    const ts = (i: number) => `${1000 + i}.0`;
    await cache.ingest(
      Array.from({ length: count }, (_, i) => ({ container, ts: ts(i), text: `m${i}`, createdAt: i })),
    );
    const before = Date.now();
    await cache.ingest(
      Array.from({ length: count }, (_, i) =>
        i % 3 === 0
          ? { container, ts: ts(i), deleted: true }
          : { container, ts: ts(i), text: `e${i}`, editedAt: before + i },
      ),
    );
    const revised = await cache.revisedSince(container, before);
    assert.equal(revised.length, count);
    assert.equal(new Set(revised.map((m) => m.ts)).size, count);
    assert.equal(revised.filter((m) => m.deleted).length, Math.ceil(count / 3));
    const known = await cache.revisedSince(container, before, { ts: [ts(1), ts(3), "9999.0"] });
    assert.deepEqual(known.map((m) => m.ts).sort(), [ts(1), ts(3)]);
  } finally {
    await cache.close();
  }
});

test("pg surface-cache: revisedSince includes self edits and scopes to a thread", async () => {
  const cache = createPostgresSurfaceCache(URL);
  const container = `Cthr-${Date.now()}`;
  try {
    await cache.ingest([
      { container, ts: "1.0", text: "root", createdAt: 1 },
      { container, ts: "1.5", sub: "1.0", text: "reply", createdAt: 2 },
      { container, ts: "2.0", text: "other root", createdAt: 3 },
      { container, ts: "2.5", sub: "2.0", text: "bot reply", self: true, createdAt: 4 },
    ]);
    await cache.ingest([
      { container, ts: "1.0", text: "root edited", editedAt: 10 },
      { container, ts: "1.5", sub: "1.0", text: "reply edited", editedAt: 11 },
      { container, ts: "2.0", text: "other root edited", editedAt: 12 },
      { container, ts: "2.5", sub: "2.0", text: "bot reply edited", self: true, editedAt: 13 },
    ]);
    assert.deepEqual(
      (await cache.revisedSince(container, 0)).map((m) => m.ts),
      ["2.5", "2.0", "1.5", "1.0"],
    );
    assert.deepEqual(
      (await cache.revisedSince(container, 0, { thread: "1.0" })).map((m) => m.ts),
      ["1.5", "1.0"],
    );
  } finally {
    await cache.close();
  }
});

test("pg mirror reads sanitize NUL, retain files and preserve newer text on a handled replay", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    await cache.ingest([
      {
        container: "CMIRROR",
        ts: "1.0",
        text: "a\0b \\u0000",
        editedAt: 50,
        files: [{ fileId: "F1", name: "notes\0.txt" }],
      },
    ]);
    await cache.ingest([{ container: "CMIRROR", ts: "1.0", text: "stale", handled: true }]);
    const [message] = await cache.readMessages("CMIRROR", { at: "1.0", noFallback: true });
    assert.equal(message?.text, "ab \\u0000");
    assert.equal(message?.handled, true);
    assert.equal(message?.files?.[0]?.name, "notes.txt");
    assert.deepEqual(await cache.readMessages("CMIRROR", { at: "2.0", noFallback: true }), []);
  } finally {
    await cache.close();
  }
});

test("cache revisions preserve attachments and parent against stale handled events", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    const base = { container: "CSNAPSHOT", ts: "2.0" };
    await cache.ingest([{ ...base, sub: "1.0", text: "latest", editedAt: 20, files: [{ fileId: "F1", name: "one" }] }]);
    await cache.ingest([
      { ...base, sub: "wrong", text: "stale", editedAt: 10, handled: true, files: [{ fileId: "F2" }] },
    ]);
    let [message] = await cache.readMessages(base.container, { at: base.ts });
    assert.equal(message?.text, "latest");
    assert.equal(message?.sub, "1.0");
    assert.equal(message?.handled, true);
    assert.deepEqual(
      message?.files?.map((f) => f.fileId),
      ["F1"],
    );
    await cache.ingest([{ ...base, sub: null, text: "root corrected", editedAt: 30 }]);
    [message] = await cache.readMessages(base.container, { at: base.ts });
    assert.equal(message?.sub, undefined);
    assert.deepEqual(
      message?.files?.map((f) => f.fileId),
      ["F1"],
    );
    await cache.ingest([{ ...base, text: "replacement", editedAt: 40, files: [{ fileId: "F2", name: "renamed" }] }]);
    [message] = await cache.readMessages(base.container, { at: base.ts });
    assert.equal(message?.sub, undefined);
    assert.deepEqual(
      message?.files?.map((f) => [f.fileId, f.name]),
      [["F2", "renamed"]],
    );
    await cache.ingest([{ ...base, text: "empty", editedAt: 50, files: [] }]);
    await cache.ingest([{ ...base, text: "stale", editedAt: 40, files: [{ fileId: "F2" }] }]);
    [message] = await cache.readMessages(base.container, { at: base.ts });
    assert.equal(message?.text, "empty");
    assert.equal(message?.files?.length ?? 0, 0);
    await cache.ingest([{ ...base, deleted: true }]);
    await cache.ingest([{ ...base, sub: "wrong", text: "revive", editedAt: 60, files: [{ fileId: "F3" }] }]);
    [message] = await cache.readMessages(base.container, { at: base.ts, includeDeleted: true });
    assert.equal(message?.deleted, true);
    assert.equal(message?.text, "empty");
    assert.equal(message?.sub, undefined);
    assert.equal(message?.files?.length ?? 0, 0);
  } finally {
    await cache.close();
  }
});

test("cache selects exact timestamps and oldest pages with live reply counts", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    const container = "CSELECT";
    await cache.ingest([
      { container, ts: "1.0", sub: null, text: "first" },
      { container, ts: "2.0", sub: "1.0", text: "reply" },
      { container, ts: "3.0", sub: "1.0", text: "deleted reply", deleted: true },
      { container, ts: "4.0", sub: null, text: "second root" },
      { container: "OTHER", ts: "5.0", sub: "1.0", text: "other container" },
    ]);
    assert.deepEqual(
      (await cache.readMessages(container, { timestamps: ["4.0", "1.0", "missing"] })).map((m) => m.ts),
      ["1.0", "4.0"],
    );
    assert.deepEqual(await cache.readMessages(container, { timestamps: [] }), []);
    await assert.rejects(cache.readMessages(container, { timestamps: Array(501).fill("1.0") }), /500/);
    const [oldest] = await cache.readMessages(container, { sub: null, oldestFirst: true, limit: 1 });
    assert.equal(oldest?.ts, "1.0");
    assert.equal(oldest?.replyCount, 1);
    assert.deepEqual(
      (await cache.readMessages(container, { sub: null, limit: 1 })).map((m) => m.ts),
      ["4.0"],
    );
    assert.deepEqual(
      (await cache.readMessages(container, { sub: "1.0", oldestFirst: true })).map((m) => m.ts),
      ["2.0"],
    );
    await cache.ingest([{ container, ts: "2.0", sub: null, text: "corrected" }]);
    assert.equal((await cache.readMessages(container, { at: "1.0" }))[0]?.replyCount, 0);
  } finally {
    await cache.close();
  }
});

test("pg attachment snapshots roll back with a failed ingestion transaction", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    const base = { container: "CATOMIC", ts: "1.0" };
    await cache.ingest([{ ...base, text: "original", files: [{ fileId: "F1" }], editedAt: 10 }]);
    await assert.rejects(
      cache.ingest([
        { ...base, text: "replacement", files: [], editedAt: 20 },
        { container: base.container, ts: "invalid timestamp", text: "invalid" },
      ]),
    );
    const [message] = await cache.readMessages(base.container, { at: base.ts });
    assert.equal(message?.text, "original");
    assert.deepEqual(
      message?.files?.map((f) => f.fileId),
      ["F1"],
    );
  } finally {
    await cache.close();
  }
});

test("channel history includes broadcasts while exact roots exclude them", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    const container = "CBROADCAST";
    await cache.ingest([
      { container, ts: "1.0", sub: null, text: "root" },
      { container, ts: "2.0", sub: "1.0", text: "ordinary reply" },
      { container, ts: "3.0", sub: "1.0", text: "broadcast", broadcast: true, editedAt: 20 },
    ]);
    await cache.ingest([
      { container, ts: "3.0", sub: "1.0", text: "stale", broadcast: false, editedAt: 10, handled: true },
    ]);
    await cache.ingest([{ container, ts: "3.0", sub: "1.0", text: "edit without subtype", editedAt: 30 }]);
    assert.deepEqual(
      (await cache.readMessages(container, { channelHistory: true })).map((m) => m.ts),
      ["1.0", "3.0"],
    );
    assert.deepEqual(
      (await cache.readMessages(container, { sub: null })).map((m) => m.ts),
      ["1.0"],
    );
    assert.equal((await cache.readMessages(container, { at: "3.0" }))[0]?.broadcast, true);
    await cache.ingest([
      { container, ts: "3.0", sub: "1.0", text: "corrected subtype", broadcast: false, editedAt: 40 },
    ]);
    assert.deepEqual(
      (await cache.readMessages(container, { channelHistory: true })).map((m) => m.ts),
      ["1.0"],
    );
  } finally {
    await cache.close();
  }
});

test("pg surface-cache: each surface's conversations stay out of another surface's search and listings", async () => {
  const cache = createPostgresSurfaceCache(URL);
  try {
    await cache.ingest([
      { container: "CSURF", ts: "100.000001", text: "quarterly zebra plan", kind: "channel", createdAt: 1 },
      {
        surface: "forum",
        container: "forum:prod:42",
        ts: "100.000002",
        sub: "100.000001",
        text: "private zebra note",
        kind: "dm",
        members: ["alice@example.com"],
        createdAt: 1,
      },
    ]);
    assert.deepEqual(
      (await cache.search("zebra")).map((m) => m.container),
      ["CSURF"],
    );
    assert.deepEqual(
      (await cache.search("zebra", { surface: "forum" })).map((m) => [m.container, m.surface]),
      [["forum:prod:42", "forum"]],
    );
    assert.equal(
      (await cache.listContainers()).some((c) => c.container === "forum:prod:42"),
      false,
    );
    assert.deepEqual(
      (await cache.listContainers({ surface: "forum" })).map((c) => c.container),
      ["forum:prod:42"],
    );
    const [dm] = await cache.readMessages("forum:prod:42", { noFallback: true });
    assert.equal(dm?.surface, "forum");
    assert.equal((await cache.readMessages("CSURF", { noFallback: true }))[0]?.surface, undefined);
    assert.equal(await cache.isMember("forum:prod:42", "alice@example.com"), true);
  } finally {
    await cache.close();
  }
});
