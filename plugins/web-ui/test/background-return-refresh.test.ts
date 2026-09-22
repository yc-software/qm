import assert from "node:assert/strict";
import test from "node:test";
import { openDeliveryStreamHarness } from "./helpers/delivery-stream-harness.ts";
import type { SessionEntry } from "../src/core-bridge.ts";

test("a backgrounded chat shows the response that completed while it was away", async (t) => {
  const row = {
    id: "s1",
    threadRef: "web:owner:repro",
    scopeId: "personal:owner",
    title: "Backgrounded chat",
    type: "dm" as const,
    createdAt: Date.now(),
  };
  const other = { ...row, id: "s2", threadRef: "web:owner:other", title: "Other chat" };
  const question = "Please answer while I lock the phone";
  const reply = "The response that finished while you were away.";
  const user: SessionEntry = { seq: 0, type: "user", createdAt: Date.now(), payload: { text: question } };
  const completed: SessionEntry[] = [
    user,
    { seq: 1, type: "assistant", createdAt: Date.now(), payload: { text: reply } },
  ];
  let entries: SessionEntry[] = [user];
  let activeRun: unknown = { runId: null, run: null, queued: [] };
  const harness = await openDeliveryStreamHarness({
    sessions: [row, other],
    transcript: (id) => (id === row.id ? entries : []),
    activeRun: () => activeRun,
    convertToLlm: () => [{ role: "user", content: question, timestamp: 0 }],
  });
  const { requests, delivery, streams, rendered, returnToTab, leaveTab, quiesce, settle, until } = harness;
  const mount = () => {
    entries = [user];
    return harness.mount();
  };
  const background = async (): Promise<void> => {
    entries = completed;
    await leaveTab();
  };
  try {
    await t.test("catches resumeIfIdle stopping at the attach attempt without the transcript catch-up", async () => {
      activeRun = { runId: "r1", run: { status: "running", replyComplete: true }, queued: [] };
      await mount();
      await background();
      assert.equal(rendered(reply), 0, "the reply must not be on screen before the tab comes back");
      returnToTab();
      await until(() => rendered(reply) === 1);
      assert.equal(rendered(question), 1, "the pre-background message must not be duplicated");
      assert.equal(requests.filter((path) => path === "/api/turn").length, 0, "returning must not start a new turn");
    });
    await t.test("catches an onResync that only refreshes sessions, or only resumes, instead of both", async () => {
      activeRun = { runId: null, run: null, queued: [] };
      await mount();
      entries = completed;
      delivery.onopen?.();
      delivery.onopen?.();
      await until(() => rendered(reply) === 1);
      assert.ok(
        requests.includes("/api/sessions"),
        `a resync must still refresh the sessions list, saw ${requests.join(", ")}`,
      );
    });
    await t.test("catches resumeIfIdle re-entering mid-stream and refetching the transcript", async () => {
      activeRun = { runId: null, run: null, queued: [] };
      await mount();
      await leaveTab();
      activeRun = { runId: "r2", run: { status: "running" }, queued: [{ runId: "r3", text: "next one" }] };
      returnToTab();
      await until(() => streams.some((es) => es.url === "/api/runs/r2/events"));
      const stream = streams.findLast((es) => es.url === "/api/runs/r2/events")!;
      stream.onopen?.();
      stream.emit("partial", { partial: "half a thought" });
      await until(() => rendered("half a thought") === 1);
      await quiesce();
      requests.length = 0;
      returnToTab();
      await settle();
      assert.deepEqual(requests, [], "a return mid-stream must not refetch the transcript");
      assert.equal(rendered("half a thought"), 1, "the live stream must survive the return");
    });
    await t.test("catches the fallback reading chatState.threadRef instead of the thread it started on", async () => {
      activeRun = { runId: null, run: null, queued: [] };
      const conv = await mount();
      let release!: () => void;
      const pending = new Promise<Response>((resolve) => {
        release = () => resolve(Response.json(activeRun));
      });
      harness.intercept = (path) => (path.startsWith("/api/runs/active") ? pending : undefined);
      await background();
      returnToTab();
      await until(() => requests.some((path) => path.startsWith("/api/runs/active")));
      harness.intercept = undefined;
      conv.mountContinuable(other.threadRef, other.id, other.scopeId, [], null, other);
      await quiesce();
      requests.length = 0;
      release();
      await settle();
      assert.deepEqual(
        requests.filter((path) => path.startsWith("/api/sessions/")),
        [],
        "the stale resume must refresh neither the chat it left nor the one now mounted",
      );
    });
  } finally {
    await harness.dispose();
  }
});
