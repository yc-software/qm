import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresSurfaceCache } from "../src/surface-cache/surface-cache.ts";
import { createPostgresChannelPolicyStore } from "../src/surface-cache/channel-policy-store.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres surface-cache tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  await p.query(
    "DROP TABLE IF EXISTS channel_messages, channel_state, channel_files, channel_policy, channel_policy_history CASCADE",
  );
  await p.end();
});

test("pg surface-cache: upsert idempotency + last-writer-wins on change-time", { skip }, async () => {
  const cache = createPostgresSurfaceCache(URL!);
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

test("pg surface-cache: markHandled sets + survives a later ingest (edit) of the same ts", { skip }, async () => {
  const cache = createPostgresSurfaceCache(URL!);
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

test("pg surface-cache: tsvector search + active threads + membership", { skip }, async () => {
  const cache = createPostgresSurfaceCache(URL!);
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
    const threads = await cache.activeThreads({ container: "CS1" });
    assert.equal(threads.length, 1, "activeThreads projects the one sub-conversation");
    assert.equal(threads[0]!.sub, "T1");
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

test(
  "pg surface-cache: activeThreads excludes deleted + sub-null rows, orders by activity, honors limit",
  { skip },
  async () => {
    const cache = createPostgresSurfaceCache(URL!);
    try {
      await cache.ingest([
        { container: "CT1", ts: "1.0", sub: "T-a", text: "a1", createdAt: 9000000000001 },
        { container: "CT1", ts: "2.0", sub: "T-a", text: "a2", createdAt: 9000000000002 },
        { container: "CT1", ts: "2.5", sub: "T-a", text: "gone", deleted: true, createdAt: 9000000000005 },
        { container: "CT1", ts: "3.0", sub: "T-b", text: "b1", createdAt: 9000000000003 },
        { container: "CT1", ts: "4.0", text: "top-level, no sub", createdAt: 9000000000004 },
        { container: "CT1", ts: "5.0", sub: "T-c", text: "only deleted", deleted: true, createdAt: 9000000000006 },
        { container: "CT2", ts: "6.0", sub: "T-d", text: "d1", createdAt: 9000000000007 },
      ]);
      const threads = await cache.activeThreads({ container: "CT1" });
      assert.equal(threads.length, 2, "sub-null, deleted-only, and other-container rows are excluded");
      assert.equal(threads[0]!.sub, "T-b", "newest live activity first");
      const a = threads.find((t) => t.sub === "T-a")!;
      assert.equal(a.messageCount, 2, "the deleted reply does not count");
      assert.equal(a.lastTs, "2.0", "the deleted reply does not advance lastTs");
      assert.equal(a.lastActivityAt, 9000000000002, "the deleted reply does not advance lastActivityAt");
      const limited = await cache.activeThreads({ limit: 1 });
      assert.equal(limited.length, 1);
      assert.equal(limited[0]!.sub, "T-d", "the cross-container query returns the newest thread");
    } finally {
      await cache.close();
    }
  },
);

test("pg surface-cache: oldest_ts is the numeric floor (ts::numeric compare, not lexical)", { skip }, async () => {
  const cache = createPostgresSurfaceCache(URL!);
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

test("pg channel-policy: set + get + list", { skip }, async () => {
  const store = createPostgresChannelPolicyStore(URL!);
  try {
    await store.set("C1", "flag anything about the Q3 launch", { setBy: "U-admin" });
    const p = await store.get("C1");
    assert.equal(p?.orders, "flag anything about the Q3 launch");
    assert.equal(p?.setBy, "U-admin");
    await store.set("C1", "stay silent unless @mentioned");
    assert.equal((await store.get("C1"))?.orders, "stay silent unless @mentioned");
    assert.equal((await store.list()).length, 1);
  } finally {
    await store.close();
  }
});

test(
  "pg channel-policy: ambientEnabled tri-state — unset default, round-trip, omitted preserved, null clears",
  { skip },
  async () => {
    const store = createPostgresChannelPolicyStore(URL!);
    try {
      await store.set("CPA1", "watch", { setBy: "U-admin" });
      assert.equal((await store.get("CPA1"))?.ambientEnabled, undefined, "unset by default");
      await store.set("CPA1", "watch", { setBy: "U-admin", ambientEnabled: false });
      assert.equal((await store.get("CPA1"))?.ambientEnabled, false);
      await store.set("CPA1", "watch more");
      assert.equal((await store.get("CPA1"))?.ambientEnabled, false, "omitted arg leaves the override unchanged");
      await store.set("CPA1", "watch more", { ambientEnabled: null });
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
  },
);

test("pg channel-policy: history appends a revision per set with provenance", { skip }, async () => {
  const store = createPostgresChannelPolicyStore(URL!);
  try {
    await store.set("CPH1", "watch the launch", { setBy: "U-alice", sessionId: "sess-1" });
    await store.set("CPH1", "watch the launch and incidents", { setBy: "U-bob", sessionId: "sess-2" });
    const h = await store.history("CPH1");
    assert.equal(h.length, 2);
    assert.equal(h[0]?.orders, "watch the launch and incidents");
    assert.equal(h[0]?.setBy, "U-bob");
    assert.equal(h[0]?.sessionId, "sess-2");
    assert.equal(h[1]?.setBy, "U-alice");
  } finally {
    await store.close();
  }
});

test("pg surface-cache: mentions JSONB round-trips and survives a mention-less edit", { skip }, async () => {
  const cache = createPostgresSurfaceCache(URL!);
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

test("pg surface-cache: revisedSince returns edits and deletions after the watermark", { skip }, async () => {
  const cache = createPostgresSurfaceCache(URL!);
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

test("pg surface-cache: revisedSince skips self edits and scopes to a thread", { skip }, async () => {
  const cache = createPostgresSurfaceCache(URL!);
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
      ["2.0", "1.5", "1.0"],
    );
    assert.deepEqual(
      (await cache.revisedSince(container, 0, { thread: "1.0" })).map((m) => m.ts),
      ["1.5", "1.0"],
    );
  } finally {
    await cache.close();
  }
});
