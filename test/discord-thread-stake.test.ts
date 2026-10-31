import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStakeTracker,
  hasBotStake,
  THREAD_NO_STAKE_TTL_MS,
  THREAD_STAKES_MAX,
} from "../src/discord/thread-stake.ts";

test("the bot has a stake if it posted or was mentioned", () => {
  assert.equal(hasBotStake([{ authorId: "9", mentionedUserIds: [] }], "9"), true);
  assert.equal(hasBotStake([{ authorId: "1", mentionedUserIds: ["9"] }], "9"), true);
  assert.equal(hasBotStake([{ authorId: "1", mentionedUserIds: [] }], "9"), false);
});

test("positive stakes stick; negatives expire; fetch failures mean no stake", async () => {
  let t = 0;
  let history = [{ authorId: "1", mentionedUserIds: [] as string[] }];
  let fetches = 0;
  const tracker = createStakeTracker({
    recent: async (id) => {
      fetches += 1;
      if (id === "boom") throw new Error("x");
      return history;
    },
    now: () => t,
  });
  assert.equal(await tracker.has("t1", "9"), false);
  history = [{ authorId: "9", mentionedUserIds: [] }];
  assert.equal(await tracker.has("t1", "9"), false);
  t = THREAD_NO_STAKE_TTL_MS + 1;
  assert.equal(await tracker.has("t1", "9"), true);
  assert.equal(fetches, 2);
  tracker.mark("t2");
  assert.equal(await tracker.has("t2", "9"), true);
  assert.equal(await tracker.has("boom", "9"), false);
});

test("concurrent checks of one thread share a single history fetch", async () => {
  let fetches = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tracker = createStakeTracker({
    recent: async () => {
      fetches += 1;
      await gate;
      return [{ authorId: "bot", mentionedUserIds: [] }];
    },
  });
  const checks = [tracker.has("t1", "bot"), tracker.has("t1", "bot"), tracker.has("t1", "bot")];
  release();
  assert.deepEqual(await Promise.all(checks), [true, true, true]);
  assert.equal(fetches, 1);
});

test("the stake memory is bounded, so the oldest staked thread is looked up again", async () => {
  const fetched: string[] = [];
  const tracker = createStakeTracker({
    recent: async (id) => (fetched.push(id), [{ authorId: "bot", mentionedUserIds: [] }]),
  });
  for (let i = 0; i <= THREAD_STAKES_MAX; i++) tracker.mark(`t${i}`);
  assert.equal(await tracker.has(`t${THREAD_STAKES_MAX}`, "bot"), true);
  assert.equal(await tracker.has("t0", "bot"), true);
  assert.deepEqual(fetched, ["t0"]);
});
