import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySurfaceCache, type LiveFallback } from "../src/surface-cache/surface-cache.ts";
import { createMemoryChannelPolicyStore } from "../src/surface-cache/channel-policy-store.ts";
import {
  judgeAmbientBatch,
  parseAmbientDecision,
  type AmbientBatch,
  type AmbientDecision,
} from "../src/surface-cache/ambient-judge.ts";

test("ingest is idempotent per (container, ts) — a re-delivery upserts, never doubles", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([{ container: "C1", ts: "100.1", authorId: "U1", text: "hello", createdAt: 1 }]);
  await cache.ingest([{ container: "C1", ts: "100.1", authorId: "U1", text: "hello", createdAt: 1 }]);
  const msgs = await cache.readMessages("C1");
  assert.equal(msgs.length, 1, "the same ts re-delivered stays a single row");
  assert.equal(msgs[0]!.text, "hello");
});

test("ingest is last-writer-wins on change-time — an edit overwrites, a stale re-send of the original does not", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([{ container: "C1", ts: "100.1", text: "original", createdAt: 1 }]);
  await cache.ingest([{ container: "C1", ts: "100.1", text: "edited", editedAt: 5, createdAt: 1 }]);
  let msgs = await cache.readMessages("C1");
  assert.equal(msgs[0]!.text, "edited", "the edit (higher change-time) wins");
  await cache.ingest([{ container: "C1", ts: "100.1", text: "original", createdAt: 1 }]);
  msgs = await cache.readMessages("C1");
  assert.equal(msgs[0]!.text, "edited", "a stale re-send of the original does not overwrite the newer edit");
});

test("a delete always wins (even after an edit) and is monotonic — a re-delivered original can't un-delete", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([{ container: "C1", ts: "1.0", text: "original", createdAt: 1 }]);
  await cache.ingest([{ container: "C1", ts: "1.0", text: "edited", editedAt: 9, createdAt: 1 }]);
  await cache.ingest([{ container: "C1", ts: "1.0", deleted: true, createdAt: 1 }]);
  let msgs = await cache.readMessages("C1", { includeDeleted: true });
  assert.equal(
    msgs[0]!.deleted,
    true,
    "the delete tombstoned the message despite the earlier edit's higher change-time",
  );
  await cache.ingest([{ container: "C1", ts: "1.0", text: "original", createdAt: 1 }]);
  msgs = await cache.readMessages("C1", { includeDeleted: true });
  assert.equal(msgs[0]!.deleted, true, "deletion is monotonic — a re-delivered original can't resurrect it");
  assert.equal((await cache.readMessages("C1")).length, 0, "the tombstoned message is hidden from the default read");
});

test("readMessages heals from the live fallback on a mirror miss", async () => {
  let called = 0;
  const liveFallback: LiveFallback = async (container) => {
    called++;
    return [{ container, ts: "9.9", authorId: "U2", text: "from the live surface", createdAt: 1 }];
  };
  const cache = createMemorySurfaceCache({ liveFallback });
  const missed = await cache.readMessages("C-empty");
  assert.equal(called, 1, "the live fallback was consulted on the miss");
  assert.equal(missed.length, 1);
  assert.equal(missed[0]!.text, "from the live surface");
  await cache.ingest([{ container: "C-hit", ts: "1.0", text: "mirrored", createdAt: 1 }]);
  const hit = await cache.readMessages("C-hit");
  assert.equal(called, 1, "a mirror hit never calls the live surface");
  assert.equal(hit[0]!.text, "mirrored");
});

test("search finds mirrored bodies and excludes deleted rows", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([
    { container: "C1", ts: "1.0", text: "the Q3 launch is next week", createdAt: 1 },
    { container: "C1", ts: "2.0", text: "unrelated banter", createdAt: 2 },
    { container: "C2", ts: "3.0", text: "another Q3 launch note", deleted: true, createdAt: 3 },
  ]);
  const hits = await cache.search("launch");
  assert.equal(hits.length, 1, "the deleted row is excluded; only the live match returns");
  assert.equal(hits[0]!.ts, "1.0");
});

test("activeThreads projects sub-conversations with recent activity, newest first", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([
    { container: "C1", ts: "1.0", sub: "T-a", text: "a1", createdAt: 1 },
    { container: "C1", ts: "2.0", sub: "T-a", text: "a2", createdAt: 2 },
    { container: "C1", ts: "3.0", sub: "T-b", text: "b1", createdAt: 3 },
    { container: "C1", ts: "4.0", text: "top-level, no sub", createdAt: 4 },
  ]);
  const threads = await cache.activeThreads({ container: "C1" });
  assert.equal(threads.length, 2, "only the two sub-conversations are threads (the top-level message isn't)");
  assert.equal(threads[0]!.sub, "T-b", "newest activity first");
  const a = threads.find((t) => t.sub === "T-a")!;
  assert.equal(a.messageCount, 2);
});

test("eager membership maintenance: ingest keeps a container's members fresh, ungated by bodies", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([
    {
      container: "C1",
      ts: "1.0",
      text: "hi",
      members: ["U1", "U2"],
      containerName: "general",
      kind: "channel",
      createdAt: 1,
    },
  ]);
  assert.deepEqual((await cache.members("C1")).sort(), ["U1", "U2"]);
  assert.equal(await cache.isMember("C1", "U1"), true);
  assert.equal(await cache.isMember("C1", "U9"), false);
  await cache.ingest([{ container: "C1", ts: "2.0", text: "more", createdAt: 2 }]);
  assert.deepEqual((await cache.members("C1")).sort(), ["U1", "U2"], "a body-only event leaves membership intact");
  const st = await cache.containerState("C1");
  assert.equal(st?.name, "general");
  assert.equal(st?.kind, "channel", "the container kind round-trips and a body-only event leaves it intact");
  assert.equal(st?.lastTs, "2.0", "the coverage watermark advances to the latest ts");
  assert.equal((await cache.listContainers()).find((c) => c.container === "C1")?.kind, "channel");
});

test("oldest_ts is the numeric floor of ingested ts — compared numerically, not lexically", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([{ container: "C1", ts: "1000.1", text: "newest", createdAt: 3 }]);
  await cache.ingest([{ container: "C1", ts: "999.1", text: "older", createdAt: 2 }]);
  await cache.ingest([{ container: "C1", ts: "1500.1", text: "even newer", createdAt: 4 }]);
  const st = await cache.containerState("C1");
  assert.equal(st?.oldestTs, "999.1", "the coverage floor is the numerically-smallest ts (not the lexically-smallest)");
});

test("channel policy store: set + get + list standing orders", async () => {
  const store = createMemoryChannelPolicyStore();
  assert.equal(await store.get("C1"), null);
  await store.set("C1", "flag anything about the Q3 launch", { setBy: "U-admin" });
  const p = await store.get("C1");
  assert.equal(p?.orders, "flag anything about the Q3 launch");
  assert.equal(p?.setBy, "U-admin");
  assert.equal((await store.list()).length, 1);
});

test("channel policy store: every set appends a provenance revision to history", async () => {
  const store = createMemoryChannelPolicyStore();
  await store.set("C1", "flag the launch", { setBy: "U-alice", sessionId: "sess-1" });
  await store.set("C1", "flag the launch and incidents", { setBy: "U-bob", sessionId: "sess-2" });
  await store.set("C-other", "unrelated", { setBy: "U-carol" });
  const h = await store.history("C1");
  assert.equal(h.length, 2, "one revision per set, other containers excluded");
  assert.equal(h[0]?.orders, "flag the launch and incidents");
  assert.equal(h[0]?.setBy, "U-bob");
  assert.equal(h[0]?.sessionId, "sess-2");
  assert.equal(h[1]?.setBy, "U-alice");
  assert.equal(h[1]?.sessionId, "sess-1");
});

test("channel policy store: bot ledger round-trips and an omitted `bots` leaves it unchanged", async () => {
  const store = createMemoryChannelPolicyStore();
  const ledger = { newsbot: { mode: "rollup" as const, rollupHours: 6 }, deploybot: { mode: "action" as const } };
  await store.set("C1", "watch the launch", { setBy: "U-admin", bots: ledger });
  const p = await store.get("C1");
  assert.deepEqual(p?.bots, ledger, "the bot ledger persists verbatim");
  await store.set("C1", "watch the launch AND the incident channel", { setBy: "U-admin" });
  const p2 = await store.get("C1");
  assert.equal(p2?.orders, "watch the launch AND the incident channel");
  assert.deepEqual(p2?.bots, ledger, "an omitted bots arg leaves the ledger unchanged");
  await store.set("C2", "hi");
  assert.deepEqual((await store.get("C2"))?.bots, {});
});

test("channel policy store: ambientEnabled is tri-state — unset by default, round-trips, omitted leaves it, null clears it", async () => {
  const store = createMemoryChannelPolicyStore();
  await store.set("C1", "watch the launch", { setBy: "U-admin" });
  assert.equal((await store.get("C1"))?.ambientEnabled, undefined, "unset by default — the size rule decides");
  await store.set("C1", "watch the launch", { setBy: "U-admin", ambientEnabled: false });
  assert.equal((await store.get("C1"))?.ambientEnabled, false, "off persists");
  await store.set("C1", "watch the launch harder", { setBy: "U-admin" });
  assert.equal((await store.get("C1"))?.ambientEnabled, false, "an omitted arg leaves the override unchanged");
  await store.set("C1", "watch the launch harder", { setBy: "U-admin", ambientEnabled: true });
  assert.equal((await store.get("C1"))?.ambientEnabled, true, "explicit on persists");
  await store.set("C1", "watch the launch harder", { setBy: "U-admin", ambientEnabled: null });
  assert.equal((await store.get("C1"))?.ambientEnabled, undefined, "null clears back to the default rule");
  const h = await store.history("C1");
  assert.deepEqual(
    h.map((r) => r.ambientEnabled),
    [undefined, false, false, true, undefined].reverse(),
    "every revision records the override, so a flip is auditable",
  );
});

test("parseAmbientDecision tolerates a JSON object, prose-wrapped JSON, and garbage", () => {
  assert.deepEqual(parseAmbientDecision('{"act": true, "reason": "matches"}'), { act: true, reason: "matches" });
  assert.deepEqual(parseAmbientDecision('Sure — {"act": false} because nothing matched'), { act: false });
  assert.deepEqual(parseAmbientDecision("not json at all"), { act: false });
  assert.deepEqual(parseAmbientDecision(undefined), { act: false });
});

test("ambient judge: engage decision spawns the smart-model worker", async () => {
  const spawned: Array<{ batch: AmbientBatch; decision: AmbientDecision }> = [];
  const batch: AmbientBatch = {
    container: "C1",
    surface: "slack",
    orders: "flag anything about the Q3 launch",
    messages: [{ container: "C1", ts: "1.0", authorId: "U1", text: "did the Q3 launch slip?", createdAt: 1 }],
  };
  const decision = await judgeAmbientBatch(
    {
      judge: async () => JSON.stringify({ act: true, reason: "someone asked about the Q3 launch" }),
      spawnWorker: async (b, d) => {
        spawned.push({ batch: b, decision: d });
      },
    },
    batch,
  );
  assert.equal(decision.act, true);
  assert.equal(spawned.length, 1, "an engage decision spawns exactly one worker");
  assert.equal(spawned[0]!.decision.reason, "someone asked about the Q3 launch");
});

test("ambient judge: a silence decision spawns NO worker (silence is the default)", async () => {
  let spawns = 0;
  const decision = await judgeAmbientBatch(
    {
      judge: async () => JSON.stringify({ act: false }),
      spawnWorker: async () => {
        spawns++;
      },
    },
    {
      container: "C1",
      surface: "slack",
      orders: "flag Q3 launch",
      messages: [{ container: "C1", ts: "1.0", text: "lunch anyone?", createdAt: 1 }],
    },
  );
  assert.equal(decision.act, false);
  assert.equal(spawns, 0);
});

test("ambient judge: empty standing orders no longer short-circuits — the judge still decides", async () => {
  let judged = 0;
  let spawns = 0;
  const decision = await judgeAmbientBatch(
    {
      judge: async () => {
        judged++;
        return JSON.stringify({ act: true, reason: "the assistant is addressed" });
      },
      spawnWorker: async () => {
        spawns++;
      },
    },
    {
      container: "C1",
      surface: "slack",
      orders: "   ",
      self: { name: "bot" },
      messages: [{ container: "C1", ts: "1.0", text: "hey bot, help?", createdAt: 1 }],
    },
  );
  assert.equal(decision.act, true);
  assert.equal(judged, 1, "the cheap-model judge is consulted even with no standing orders");
  assert.equal(spawns, 1);
});

test("ambient judge: the agent's own posts are never shown to the judge as new messages", async () => {
  let sawText = "";
  const decision = await judgeAmbientBatch(
    {
      judge: async (_s, prompt) => {
        sawText = prompt;
        return JSON.stringify({ act: false });
      },
      spawnWorker: async () => {},
    },
    {
      container: "C1",
      surface: "slack",
      orders: "flag launch talk",
      messages: [{ container: "C1", ts: "1.0", text: "", deleted: true, createdAt: 1 }],
    },
  );
  assert.equal(decision.act, false, "an empty/deleted-only batch is not judged into acting");
  assert.equal(sawText, "", "the judge isn't even called when there's nothing meaningful to show");
});

test("mentions round-trip through ingest → readMessages (memory)", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([{ container: "C1", ts: "100.9", text: "hi @jordan", mentions: { U1: "jordan" }, createdAt: 1 }]);
  const msgs = await cache.readMessages("C1");
  assert.deepEqual(msgs[0]!.mentions, { U1: "jordan" }, "the mentions map survives the round-trip");
  await cache.ingest([{ container: "C1", ts: "100.9", text: "hi @jordan", editedAt: 5, createdAt: 1 }]);
  const after = await cache.readMessages("C1");
  assert.deepEqual(after[0]!.mentions, { U1: "jordan" }, "a mention-less edit keeps the prior mentions");
});

test("mentionsSelf round-trips through ingest → readMessages (memory)", async () => {
  const cache = createMemorySurfaceCache();
  await cache.ingest([
    { container: "C1", ts: "1.0", text: "@bot help", mentionsSelf: true, createdAt: 1 },
    { container: "C1", ts: "2.0", text: "just chatting", createdAt: 2 },
  ]);
  const msgs = await cache.readMessages("C1");
  assert.equal(msgs.find((m) => m.ts === "1.0")!.mentionsSelf, true, "a self-mention survives the round-trip");
  assert.equal(msgs.find((m) => m.ts === "2.0")!.mentionsSelf, undefined, "a non-mention carries no flag");
  await cache.ingest([{ container: "C1", ts: "1.0", text: "@bot help", editedAt: 5, createdAt: 1 }]);
  const after = await cache.readMessages("C1");
  assert.equal(after.find((m) => m.ts === "1.0")!.mentionsSelf, true, "an edit keeps the prior self-mention flag");
});
