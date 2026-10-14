import { test } from "node:test";
import assert from "node:assert/strict";
import { createAckPresenter, stripAckPrefix, renderGoalNotice, createGoalNoticePresenter } from "../src/slack/lib.ts";

function presenterHarness(opts: { reactionDelayMs?: number } = {}) {
  const calls: string[] = [];
  const presenter = createAckPresenter({
    postAck: async (t) => {
      calls.push(`post:${t}`);
    },
    addReaction: async (e) => {
      calls.push(`add:${e}`);
    },
    removeReaction: async (e) => {
      calls.push(`remove:${e}`);
    },
    emojiCandidates: ["eyes"],
    reactionDelayMs: opts.reactionDelayMs ?? 10,
    random: () => 0,
  });
  return { presenter, calls };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("ack presenter: a short first block posts as the ack and suppresses the fallback reaction", async () => {
  const { presenter, calls } = presenterHarness({ reactionDelayMs: 50 });
  presenter.onFirstBlock("On it — checking the deploy logs.");
  await tick(80);
  await presenter.settle();
  assert.deepEqual(calls, ["post:On it — checking the deploy logs."]);
});

test("ack presenter: nothing visible by the deadline → ONE reaction, removed on settle (never left stuck)", async () => {
  const { presenter, calls } = presenterHarness({ reactionDelayMs: 5 });
  await tick(30);
  await presenter.settle();
  assert.deepEqual(calls, ["add:eyes", "remove:eyes"]);
});

test("ack presenter: an ack arriving after the reaction removes it before posting (never both at once)", async () => {
  const { presenter, calls } = presenterHarness({ reactionDelayMs: 5 });
  await tick(30);
  presenter.onFirstBlock("On it.");
  await presenter.settle();
  assert.deepEqual(calls, ["add:eyes", "remove:eyes", "post:On it."]);
});

test("ack presenter: a long first block still posts as the ack (no length gate)", async () => {
  const { presenter, calls } = presenterHarness({ reactionDelayMs: 5_000 });
  const long = "y".repeat(400);
  presenter.onFirstBlock(long);
  await presenter.settle();
  assert.deepEqual(calls, [`post:${long}`]);
});

test("ack presenter: onSurfacePosted clears the reaction (spine post reached the channel)", async () => {
  const { presenter, calls } = presenterHarness({ reactionDelayMs: 5 });
  await tick(30);
  presenter.onSurfacePosted();
  await presenter.settle();
  assert.deepEqual(calls, ["add:eyes", "remove:eyes"]);
});

test("ack presenter: settle before the deadline cancels the pending reaction entirely", async () => {
  const { presenter, calls } = presenterHarness({ reactionDelayMs: 30 });
  await presenter.settle();
  await tick(60);
  assert.deepEqual(calls, []);
});

test("ack presenter: only the FIRST first-block signal counts", async () => {
  const { presenter, calls } = presenterHarness({ reactionDelayMs: 5_000 });
  presenter.onFirstBlock("On it.");
  presenter.onFirstBlock("Second block never posts.");
  await presenter.settle();
  assert.deepEqual(calls, ["post:On it."]);
});

function pickHarness(emojiPick: Promise<string | undefined>) {
  const calls: string[] = [];
  const presenter = createAckPresenter({
    postAck: async (t) => void calls.push(`post:${t}`),
    addReaction: async (e) => void calls.push(`add:${e}`),
    removeReaction: async (e) => void calls.push(`remove:${e}`),
    emojiCandidates: ["eyes", "bug"],
    emojiPick,
    reactionDelayMs: 5,
    random: () => 0,
  });
  return { presenter, calls };
}

test("ack presenter: a topical pick that arrives in time is used (and removed on settle)", async () => {
  const { presenter, calls } = pickHarness(Promise.resolve("bug"));
  await tick(30);
  await presenter.settle();
  assert.deepEqual(calls, ["add:bug", "remove:bug"]);
});

test("ack presenter: a declined pick (undefined) falls back to a random candidate", async () => {
  const { presenter, calls } = pickHarness(Promise.resolve(undefined));
  await tick(30);
  await presenter.settle();
  assert.deepEqual(calls, ["add:eyes", "remove:eyes"]);
});

test("ack presenter: a pick that isn't ready when the timer fires falls back to random (never awaited)", async () => {
  let resolvePick: (v: string) => void = () => {};
  const { presenter, calls } = pickHarness(new Promise<string>((r) => (resolvePick = r)));
  await tick(30);
  resolvePick("bug");
  await presenter.settle();
  assert.deepEqual(calls, ["add:eyes", "remove:eyes"]);
});

test("ack presenter: settle never blocks on a never-resolving pick", async () => {
  const { presenter, calls } = pickHarness(new Promise<string>(() => {}));
  await tick(30);
  await presenter.settle();
  assert.deepEqual(calls, ["add:eyes", "remove:eyes"]);
});

test("stripAckPrefix: removes exactly the posted ack prefix (plus the gap), and only when it leads", () => {
  assert.equal(stripAckPrefix("On it.\n\nDone — cloned it.", "On it."), "Done — cloned it.");
  assert.equal(stripAckPrefix("  On it.\nDone.", "On it."), "Done.");
  assert.equal(stripAckPrefix("Done. On it.", "On it."), "Done. On it.", "non-prefix mentions stay");
  assert.equal(stripAckPrefix("Done.", undefined), "Done.", "no ack posted → untouched");
});

test("ack presenter: postedAck exposes the exact posted text; a held block exposes none", async () => {
  const posted = presenterHarness({ reactionDelayMs: 5_000 });
  posted.presenter.onFirstBlock("On it — checking.");
  await posted.presenter.settle();
  assert.equal(posted.presenter.postedAck(), "On it — checking.");

  const long = presenterHarness({ reactionDelayMs: 5_000 });
  long.presenter.onFirstBlock("z".repeat(400));
  await long.presenter.settle();
  assert.equal(long.presenter.postedAck(), "z".repeat(400), "a long block posts too — and is exposed for the strip");
});

test("ack presenter does not report a failed post as surfaced", async () => {
  const presenter = createAckPresenter({
    postAck: async () => {
      throw new Error("checkpoint failed");
    },
    addReaction: async () => {},
    removeReaction: async () => {},
  });
  presenter.onFirstBlock("On it.");
  await presenter.settle();
  assert.equal(presenter.postedAck(), undefined);
});

test("renderGoalNotice: one line per status, floor shown while active", () => {
  assert.equal(
    renderGoalNotice({ objective: "get the tests\ngreen <fast>", status: "active", floor: "30m" }),
    "◐ Pursuing goal: get the tests green &lt;fast&gt; · at least 30m",
  );
  assert.equal(renderGoalNotice({ objective: "obj", status: "complete" }), "✓ Goal complete: obj");
  assert.equal(renderGoalNotice({ objective: "obj", status: "cancelled" }), "✕ Goal cancelled: obj");
  assert.equal(renderGoalNotice({ objective: "obj", status: "paused" }), "⏸ Goal paused: obj");
});

test("goal notice presenter posts once, updates in place, and dedupes", async () => {
  const posts: string[] = [];
  const updates: Array<{ ts: string; text: string }> = [];
  const presenter = createGoalNoticePresenter({
    post: async (text) => {
      posts.push(text);
      return "111.222";
    },
    update: async (ts, text) => {
      updates.push({ ts, text });
    },
  });
  await presenter.onGoal({ objective: "obj", status: "active" });
  await presenter.onGoal({ objective: "obj", status: "active" });
  await presenter.onGoal({ objective: "obj", status: "complete" });
  await presenter.settle();
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /Pursuing goal/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.ts, "111.222");
  assert.match(updates[0]!.text, /Goal complete/);
});
