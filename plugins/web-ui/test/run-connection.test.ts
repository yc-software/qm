import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { makeRunResumeStreamFn } from "../src/core-bridge.ts";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

const model = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

function streamingFetch(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const state = {
    polls: 0,
    opens: 0,
    drop() {
      controller.error(new Error("connection lost"));
    },
    closed: false,
    send(value: unknown, id?: string) {
      controller.enqueue(new TextEncoder().encode(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(value)}\n\n`));
    },
  };
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("/events")) {
      state.polls++;
      return Response.json({ status: "done", result: { status: "ok", stopped: true } });
    }
    state.opens++;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        state.closed = true;
      },
    });
    init?.signal?.addEventListener(
      "abort",
      () => {
        if (!state.closed) {
          state.closed = true;
          controller.error(new DOMException("aborted", "AbortError"));
        }
      },
      { once: true },
    );
    state.send({ type: "RUN_STARTED", threadId: "r", runId: "r" });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  return state;
}

for (const heartbeat of [false, true]) {
  test(`a silent stream falls back to polling${heartbeat ? " after its last heartbeat" : ""}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const state = streamingFetch(t);
    const stream = await makeRunResumeStreamFn("r")(model, {} as Context, {});
    await flush();
    if (heartbeat) {
      t.mock.timers.tick(20_000);
      state.send({ type: "CUSTOM", name: "run", value: { status: "running", result: null, alive: true } });
      await flush();
      t.mock.timers.tick(20_000);
      await flush();
      assert.equal(state.polls, 0);
    }
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(state.polls, 1);
    assert.equal(state.closed, true);
    assert.equal((await stream.result()).stopReason, "aborted");
    t.mock.timers.tick(60_000);
    assert.equal(state.polls, 1);
  });
}

test("a stalled poll times out and retries without losing the run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 15_000);
    return timeout.signal;
  });
  let polls = 0;
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    polls++;
    if (polls > 1) return Response.json({ status: "done", result: { status: "ok", reply: "done" } });
    requestSignal = init?.signal;
    return new Promise<Response>((_, reject) =>
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason)),
    );
  });
  const stream = await makeRunResumeStreamFn("r")(model, {} as Context, {});
  await flush();
  assert.ok(requestSignal);
  timeout.abort(new DOMException("timed out", "TimeoutError"));
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(polls, 2);
  assert.equal((await stream.result()).stopReason, "stop");
});

for (const terminal of [true, false]) {
  test(`${terminal ? "terminal completion" : "detaching"} cancels the watchdog`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const state = streamingFetch(t);
    const controller = new AbortController();
    const stream = await makeRunResumeStreamFn("r")(model, {} as Context, { signal: controller.signal });
    await flush();
    if (terminal)
      state.send({ type: "CUSTOM", name: "run", value: { status: "done", result: { status: "ok", reply: "done" } } });
    else controller.abort();
    await stream.result();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(state.closed, true);
    assert.equal(state.polls, 0);
  });
}

test("TanStack assembles snapshot hydration and overlapping Unicode deltas exactly once", async (t) => {
  const state = streamingFetch(t);
  const stream = await makeRunResumeStreamFn("r")(model, {} as Context, {});
  await flush();
  state.send({ type: "CUSTOM", name: "run", value: { status: "running", result: null, partial: "hello " } });
  state.send({ type: "CUSTOM", name: "delta", value: { offset: 6, delta: "🌍" } });
  state.send({ type: "CUSTOM", name: "delta", value: { offset: 6, delta: "🌍!" } });
  state.send({ type: "CUSTOM", name: "run", value: { status: "running", result: null, partial: "hello 🌍! more" } });
  state.send({ type: "CUSTOM", name: "delta", value: { offset: 14, delta: " text" } });
  state.send({ type: "CUSTOM", name: "run", value: { status: "done", result: { status: "ok" } } });
  const result = await stream.result();
  assert.deepEqual(result.content, [{ type: "text", text: "hello 🌍! more text" }]);
  assert.equal(state.polls, 0);
});

test("TanStack reconnects after a transport drop and deduplicates replayed offsets", async (t) => {
  const state = streamingFetch(t);
  const stream = await makeRunResumeStreamFn("r")(model, {} as Context, {});
  await flush();
  state.send({ type: "CUSTOM", name: "delta", value: { offset: 0, delta: "hello" } }, "text:5");
  await flush();
  state.drop();
  for (let i = 0; i < 200 && state.opens < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(state.opens, 2);
  state.send({ type: "CUSTOM", name: "delta", value: { offset: 0, delta: "hello" } }, "text:5");
  state.send({ type: "CUSTOM", name: "delta", value: { offset: 5, delta: " world" } }, "text:11");
  state.send({ type: "CUSTOM", name: "run", value: { status: "done", result: { status: "ok" } } });
  assert.deepEqual((await stream.result()).content, [{ type: "text", text: "hello world" }]);
  assert.equal(state.polls, 0);
});

test("reply completion waits for final result metadata rather than dropping approvals", async (t) => {
  const state = streamingFetch(t);
  const stream = await makeRunResumeStreamFn("r")(model, {} as Context, {});
  await flush();
  state.send({
    type: "CUSTOM",
    name: "run",
    value: { status: "running", result: null, partial: "waiting", replyComplete: true },
  });
  await flush();
  assert.equal(state.closed, false);
  state.send({
    type: "CUSTOM",
    name: "run",
    value: {
      status: "done",
      result: {
        status: "pending_approval",
        pendingApprovals: [{ requestId: "a", command: "test", reason: "approval" }],
      },
    },
  });
  const message = await stream.result();
  assert.equal(
    (message as unknown as { work: { pendingApprovals: Array<{ requestId: string }> } }).work.pendingApprovals[0]
      ?.requestId,
    "a",
  );
  assert.equal(state.polls, 0);
});
