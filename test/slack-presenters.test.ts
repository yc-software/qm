import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderTaskList,
  createTaskListPresenter,
  createAckPresenter,
  createNativeAgentPresenter,
  stripAckPrefix,
} from "../src/slack/lib.ts";

test("native agent presenter streams text and public task progress into one message", async () => {
  const calls: Array<{ method: string; body: unknown }> = [];
  const presenter = createNativeAgentPresenter({
    setStatus: async (status) => {
      calls.push({ method: "status", body: status });
    },
    start: async (chunks) => {
      calls.push({ method: "start", body: chunks });
      return "171.1";
    },
    append: async (ts, chunks) => {
      calls.push({ method: `append:${ts}`, body: chunks });
    },
    stop: async (ts) => {
      calls.push({ method: `stop:${ts}`, body: null });
    },
    remove: async (ts) => {
      calls.push({ method: `remove:${ts}`, body: null });
    },
    checkpoint: async (ts) => {
      calls.push({ method: "checkpoint", body: ts });
    },
    onSurfacePosted: () => calls.push({ method: "surface", body: null }),
  });

  await presenter.begin();
  assert.equal(await presenter.onDelta("Checking "), true);
  assert.equal(await presenter.onTasks([{ id: "lookup", title: "Inspect deployment", status: "in_progress" }]), true);
  assert.equal(await presenter.onDelta("now."), true);
  assert.equal(await presenter.finalize(), true);

  assert.deepEqual(calls, [
    { method: "status", body: "Thinking…" },
    { method: "start", body: [{ type: "markdown_text", text: "Checking " }] },
    { method: "checkpoint", body: "171.1" },
    { method: "surface", body: null },
    {
      method: "append:171.1",
      body: [{ type: "task_update", id: "lookup", title: "Inspect deployment", status: "in_progress" }],
    },
    { method: "append:171.1", body: [{ type: "markdown_text", text: "now." }] },
    { method: "stop:171.1", body: null },
    { method: "status", body: "" },
  ]);
});

test("native agent presenter falls back cleanly when Slack streaming is unavailable", async () => {
  const calls: string[] = [];
  const presenter = createNativeAgentPresenter({
    setStatus: async (status) => {
      calls.push(`status:${status}`);
    },
    start: async () => {
      calls.push("start");
      throw new Error("unknown_method");
    },
    append: async () => {
      calls.push("append");
    },
    stop: async () => {
      calls.push("stop");
    },
    remove: async () => {
      calls.push("remove");
    },
    checkpoint: async () => {
      calls.push("checkpoint");
    },
    onSurfacePosted: () => calls.push("surface"),
    onError: (error) => calls.push(`error:${error instanceof Error ? error.message : String(error)}`),
  });

  await presenter.begin();
  assert.equal(await presenter.onDelta("Answer"), false);
  assert.equal(await presenter.onTasks([{ id: "lookup", title: "Inspect deployment", status: "in_progress" }]), false);
  assert.equal(await presenter.finalize(), false);
  assert.deepEqual(calls, ["status:Thinking…", "start", "error:unknown_method", "status:"]);
});

test("native agent presenter removes an uncheckpointed stream before falling back", async () => {
  const calls: string[] = [];
  const presenter = createNativeAgentPresenter({
    setStatus: async (status) => {
      calls.push(`status:${status}`);
    },
    start: async () => {
      calls.push("start");
      return "171.7";
    },
    append: async () => {
      calls.push("append");
    },
    stop: async () => {
      calls.push("stop");
    },
    remove: async (ts) => {
      calls.push(`remove:${ts}`);
    },
    checkpoint: async () => {
      calls.push("checkpoint");
      throw new Error("core unavailable");
    },
    onSurfacePosted: () => calls.push("surface"),
    onError: (error) => calls.push(`error:${error instanceof Error ? error.message : String(error)}`),
  });

  await presenter.begin();
  assert.equal(await presenter.onDelta("Answer"), false);
  assert.equal(await presenter.finalize(), false);
  assert.deepEqual(calls, [
    "status:Thinking…",
    "start",
    "checkpoint",
    "remove:171.7",
    "error:core unavailable",
    "status:",
  ]);
});

test("native agent presenter deletes a partial stream before fallback after append fails", async () => {
  const calls: string[] = [];
  const presenter = createNativeAgentPresenter({
    setStatus: async (status) => {
      calls.push(`status:${status}`);
    },
    start: async () => {
      calls.push("start");
      return "171.8";
    },
    append: async () => {
      calls.push("append");
      throw new Error("stream disconnected");
    },
    stop: async () => {
      calls.push("stop");
    },
    remove: async (ts) => {
      calls.push(`remove:${ts}`);
    },
    checkpoint: async () => {
      calls.push("checkpoint");
    },
    onSurfacePosted: () => calls.push("surface"),
    onError: (error) => calls.push(`error:${error instanceof Error ? error.message : String(error)}`),
  });

  await presenter.begin();
  assert.equal(await presenter.onDelta("Partial"), true);
  assert.equal(await presenter.onDelta(" answer"), false);
  assert.equal(await presenter.finalize(), false);
  assert.deepEqual(calls, [
    "status:Thinking…",
    "start",
    "checkpoint",
    "surface",
    "append",
    "remove:171.8",
    "error:stream disconnected",
    "status:",
  ]);
});

test("native agent presenter clears status after a delayed begin", async () => {
  const calls: string[] = [];
  let releaseStatus: (() => void) | undefined;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  const presenter = createNativeAgentPresenter({
    setStatus: async (status) => {
      calls.push(`status:${status}`);
      if (status) await statusGate;
    },
    start: async () => undefined,
    append: async () => {},
    stop: async () => {},
    remove: async () => {},
    checkpoint: async () => {},
    onSurfacePosted: () => {},
  });

  const beginning = presenter.begin();
  const finalizing = presenter.finalize();
  releaseStatus?.();
  await beginning;
  assert.equal(await finalizing, false);
  assert.deepEqual(calls, ["status:Thinking…", "status:"]);
});

test("native agent presenter suppresses fallback when a failed partial stream cannot be removed", async () => {
  const presenter = createNativeAgentPresenter({
    setStatus: async () => {},
    start: async () => "171.9",
    append: async () => {
      throw new Error("stream disconnected");
    },
    stop: async () => {},
    remove: async () => {
      throw new Error("delete failed");
    },
    checkpoint: async () => {},
    onSurfacePosted: () => {},
  });

  await presenter.begin();
  assert.equal(await presenter.onDelta("Partial"), true);
  assert.equal(await presenter.onDelta(" answer"), false);
  assert.equal(await presenter.finalize(), true);
});

test("renderTaskList renders every terminal state", () => {
  assert.equal(
    renderTaskList([
      { id: "a", title: "done", status: "completed" },
      { id: "b", title: "omitted", status: "skipped" },
      { id: "c", title: "broken", status: "failed" },
    ]),
    "*3 tasks*\n✓ ~done~\n– ~omitted~\n✕ ~broken~",
  );
});

test("renderTaskList escapes task titles as Slack text", () => {
  assert.equal(
    renderTaskList([{ id: "a", title: "inspect <@U123> & report", status: "pending" }]),
    "*1 task*\n○ inspect &lt;@U123&gt; &amp; report",
  );
});

test("renderTaskList preserves distinct tasks that share a title", () => {
  assert.equal(
    renderTaskList([
      { id: "a", title: "research queue", status: "failed" },
      { id: "b", title: "research queue", status: "in_progress" },
      { id: "c", title: "write report", status: "completed" },
    ]),
    "*3 tasks*\n✕ ~research queue~\n◐ research queue\n✓ ~write report~",
  );
});

test("renderTaskList bounds rows and normalizes titles to one line", () => {
  const rendered = renderTaskList(
    Array.from({ length: 25 }, (_, index) => ({
      id: String(index),
      title: `${index} ${"x".repeat(140)}\nforged row`,
      status: "pending" as const,
    })),
  );
  assert.ok(rendered.length < 3_000);
  assert.match(rendered, /… 5 more$/);
  assert.equal(rendered.includes("\nforged row"), false);
});

test("task presenter posts once, updates in place, checkpoints, and finalizes the same message", async () => {
  const calls: string[] = [];
  const presenter = createTaskListPresenter({
    post: async (text) => {
      calls.push(`post:${text}`);
      return "171.2";
    },
    update: async (ts, text) => {
      calls.push(`update:${ts}:${text}`);
    },
    checkpoint: async (ts) => {
      calls.push(`checkpoint:${ts}`);
    },
    remove: async (ts) => {
      calls.push(`remove:${ts}`);
    },
    onSurfacePosted: () => calls.push("surface"),
  });

  await presenter.onTasks([{ id: "a", title: "research", status: "pending" }]);
  await presenter.onTasks([{ id: "a", title: "research", status: "completed" }]);
  assert.equal(await presenter.finalize("Final answer"), true);
  assert.deepEqual(calls, [
    "post:*1 task*\n○ research",
    "checkpoint:171.2",
    "surface",
    "update:171.2:*1 task*\n✓ ~research~",
    "update:171.2:Final answer",
  ]);
});

test("task presenter attaches beneath an existing ack and retries terminal updates", async () => {
  const calls: string[] = [];
  let attempts = 0;
  const presenter = createTaskListPresenter({
    post: async () => {
      throw new Error("must not post");
    },
    update: async (ts, text) => {
      attempts += 1;
      calls.push(`${ts}:${text}`);
      if (text === "Final" && attempts < 4) throw new Error("transient");
    },
    checkpoint: async (ts) => {
      calls.push(`checkpoint:${ts}`);
    },
    remove: async (ts) => {
      calls.push(`remove:${ts}`);
    },
    onSurfacePosted: () => calls.push("surface"),
    sleep: async () => {},
  });
  await presenter.attach("171.3", "On it.");
  await presenter.onTasks([{ id: "a", title: "consult", status: "in_progress" }]);
  assert.equal(await presenter.finalize("Final"), true);
  assert.deepEqual(calls, [
    "checkpoint:171.3",
    "171.3:On it.\n\n*1 task*\n◐ consult",
    "171.3:Final",
    "171.3:Final",
    "171.3:Final",
  ]);
});

test("task presenter merges a late ack into the existing task message", async () => {
  const calls: string[] = [];
  const presenter = createTaskListPresenter({
    post: async () => "171.4",
    update: async (ts, text) => {
      calls.push(`${ts}:${text}`);
    },
    checkpoint: async () => {},
    remove: async () => {},
    onSurfacePosted: () => {},
  });
  await presenter.onTasks([{ id: "a", title: "research", status: "in_progress" }]);
  assert.equal(await presenter.addLead("Still working."), true);
  assert.deepEqual(calls, ["171.4:Still working.\n\n*1 task*\n◐ research"]);
});

test("task presenter removes an ack whose durable checkpoint fails", async () => {
  const removed: string[] = [];
  const presenter = createTaskListPresenter({
    post: async () => undefined,
    update: async () => {},
    checkpoint: async () => {
      throw new Error("core unavailable");
    },
    remove: async (ts) => {
      removed.push(ts);
    },
    onSurfacePosted: () => {},
  });
  await assert.rejects(presenter.attach("171.5", "On it."), /core unavailable/);
  assert.deepEqual(removed, ["171.5"]);
});

test("task presenter reports a failed late-ack merge", async () => {
  const removed: string[] = [];
  const presenter = createTaskListPresenter({
    post: async () => "171.6",
    update: async () => {
      throw new Error("Slack unavailable");
    },
    checkpoint: async () => {},
    remove: async (ts) => {
      removed.push(ts);
    },
    onSurfacePosted: () => {},
    sleep: async () => {},
  });
  await presenter.onTasks([{ id: "a", title: "research", status: "in_progress" }]);
  assert.equal(await presenter.addLead("Still working."), false);
  assert.deepEqual(removed, ["171.6"]);
});

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
