import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryAckEmojiPickStore,
  createPostgresAckEmojiPickStore,
  type AckEmojiPickStore,
} from "../src/surface-cache/ack-emoji-pick-store.ts";

const URL = process.env.DATABASE_URL;
const pgSkip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres ack-emoji-pick tests";

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS ack_emoji_picks CASCADE");
  await p.end();
});

async function contract(store: AckEmojiPickStore): Promise<void> {
  await store.record({
    surface: "slack",
    channel: "C1",
    ts: "1.0",
    outcome: "picked",
    picked: "pirate_flag",
    icon: "🏴‍☠️",
    message: "who is your favorite pirate",
    candidates: "pirate_flag bug eyes crab",
    model: "claude-haiku-4-5",
    latencyMs: 42,
    createdAt: 100,
  });
  await store.record({
    surface: "slack",
    channel: "C1",
    ts: "2.0",
    outcome: "declined",
    message: "hmm",
    candidates: "eyes mag",
    createdAt: 200,
  });
  await store.record({ surface: "slack", channel: "C2", ts: "3.0", outcome: "picked", picked: "crab", createdAt: 300 });

  const all = await store.list();
  assert.equal(all.length, 3);
  assert.equal(all[0]!.createdAt, 300, "newest first");

  const c1 = await store.list({ channel: "C1" });
  assert.equal(c1.length, 2, "channel filter");
  const pick = c1.find((p) => p.outcome === "picked")!;
  assert.equal((pick as { candidates?: string }).candidates, undefined, "list omits the heavy candidate slate");
  assert.equal(pick.picked, "pirate_flag");
  assert.equal(pick.icon, "🏴‍☠️", "icon survives the list projection");
  assert.equal(pick.model, "claude-haiku-4-5");
  assert.equal(pick.latencyMs, 42);

  const detail = await store.get(pick.id!);
  assert.equal(detail!.candidates, "pirate_flag bug eyes crab");

  const declined = await store.list({ outcome: ["declined"] });
  assert.deepEqual(
    declined.map((p) => p.outcome),
    ["declined"],
    "outcome filter",
  );

  const before = await store.list({ before: 300 });
  assert.deepEqual(
    before.map((p) => p.createdAt),
    [200, 100],
    "before cursor pages older",
  );

  const counts = await store.counts();
  assert.deepEqual(counts, { picked: 2, declined: 1 });
  assert.deepEqual(await store.counts({ channel: "C1" }), { picked: 1, declined: 1 }, "counts respect channel");

  await store.record({ surface: "slack", channel: "C9", ts: "5.0", outcome: "picked", picked: "fire", createdAt: 500 });
  await store.record({ surface: "slack", channel: "C9", ts: "5.1", outcome: "picked", picked: "zap", createdAt: 500 });
  const tieHead = await store.list({ channel: "C9", limit: 1 });
  assert.equal(tieHead.length, 1);
  const tieNext = await store.list({
    channel: "C9",
    before: tieHead[0]!.createdAt,
    beforeId: tieHead[0]!.id,
    limit: 1,
  });
  assert.equal(tieNext.length, 1, "the tied sibling is not skipped");
  assert.notEqual(tieNext[0]!.id, tieHead[0]!.id, "and it's a distinct row");
}

test("memory ack-emoji-pick store: record + list contract", async () => {
  const store = createMemoryAckEmojiPickStore();
  await contract(store);
  await store.close();
});

test("memory ack-emoji-pick store: bounded at 5000 rows", async () => {
  const store = createMemoryAckEmojiPickStore();
  for (let i = 0; i < 5010; i++)
    await store.record({ surface: "slack", channel: "C1", ts: String(i), outcome: "declined", createdAt: i });
  const all = await store.list({ limit: 1000 });
  assert.equal(all.length, 1000, "list caps at 1000");
  assert.equal(all[0]!.createdAt, 5009, "the most recent survived the bound");
  assert.equal(all.at(-1)!.createdAt, 4010, "older rows past the 5000-row bound were dropped");
});

test("pg ack-emoji-pick store: record + list contract", { skip: pgSkip }, async () => {
  const store = createPostgresAckEmojiPickStore(URL!);
  await contract(store);
  await store.close();
});
