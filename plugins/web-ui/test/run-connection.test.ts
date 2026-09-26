import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  continuableMessages,
  makeCoreStreamFn,
  makeRunResumeStreamFn,
  messagesWithStreaming,
  resumeAnchor,
  RUN_IDLE_MS,
  setClock,
  userSendMessage,
} from "../src/core-bridge.ts";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

const model = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

for (const withAttachments of [false, true]) {
  test(`a timed-out send reconnects to its original input${withAttachments ? " with attachments" : ""}`, async (t) => {
    let time = 0;
    setClock(() => time);
    t.after(() => setClock(() => Date.now()));
    const attachments = withAttachments
      ? [{ id: "notes", type: "document", fileName: "notes.txt", mimeType: "text/plain", size: 5, content: "bm90ZXM=" }]
      : undefined;
    const input = userSendMessage("Check my document", attachments);
    const agent = new Agent({ initialState: { model, messages: [input] } });
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
      if (String(url).includes("/api/blobs")) return Response.json({ blobId: "notes-blob", sizeBytes: 5 });
      if (String(url).endsWith("/api/turn")) return Response.json({ status: "queued", runId: "r" });
      assert.equal((input as unknown as { runId?: string }).runId, "r");
      time = RUN_IDLE_MS + 1;
      return Response.json({ status: "running", result: null });
    });
    agent.streamFn = makeCoreStreamFn("web:u:reconnect", agent);
    await agent.continue();
    const failed = agent.state.messages.at(-1);
    assert.equal((failed as { stopReason?: string }).stopReason, "error");
    const resumed = continuableMessages(agent.state.messages, {
      runId: "r",
      seq: 10,
      text: "Check my document",
      createdAt: 1,
    });
    assert.deepEqual(resumed.messages, [input]);
    assert.deepEqual(resumed.popped, [failed]);
    assert.deepEqual((resumed.messages[0] as unknown as { attachments?: unknown[] }).attachments, attachments);
    agent.state.messages = resumed.messages;
    agent.streamFn = makeRunResumeStreamFn("r", { status: "done", result: { status: "ok", reply: "Done" } });
    await agent.continue();
    assert.equal(agent.state.messages.length, 2);
    assert.equal(agent.state.messages[0], input);
    const reply = agent.state.messages[1];
    assert.ok(reply?.role === "assistant");
    assert.deepEqual(reply.content, [{ type: "text", text: "Done" }]);
  });
}

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

test("tool call events on the run stream leave the streamed reply untouched", async (t) => {
  const state = streamingFetch(t);
  const stream = await makeRunResumeStreamFn("r")(model, {} as Context, {});
  await flush();
  state.send(
    { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "execute", args: { command: "ls" } },
    "tool:c1:start",
  );
  state.send({ type: "CUSTOM", name: "run", value: { status: "running", result: null, partial: "hello" } });
  state.send({ type: "TOOL_CALL_RESULT", toolCallId: "c1", content: "a.txt", isError: false }, "tool:c1:result");
  state.send({ type: "CUSTOM", name: "delta", value: { offset: 5, delta: " world" } }, "text:11");
  state.send({ type: "CUSTOM", name: "run", value: { status: "done", result: { status: "ok" } } });
  assert.deepEqual((await stream.result()).content, [{ type: "text", text: "hello world" }]);
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

test("approval activity reaches the visible transcript before any response text", async (t) => {
  const transport = streamingFetch(t);
  const agent = new Agent({ initialState: { model, messages: [resumeAnchor()] } });
  let projected: ReturnType<typeof messagesWithStreaming> = [];
  agent.streamFn = makeRunResumeStreamFn("r", undefined, () => {
    projected = messagesWithStreaming(agent.state.messages, agent.state.streamingMessage);
  });
  const completion = agent.continue();
  await flush();
  transport.send({
    type: "CUSTOM",
    name: "run",
    value: {
      status: "running",
      result: null,
      activity: [
        {
          seq: 57,
          parentSeq: null,
          type: "approval_resolved",
          payload: { requestId: "a", command: "help", approved: true, scope: "once" },
          createdAt: 100,
        },
      ],
    },
  });
  await flush();
  const beforeCompletion = projected.map((message) => (message as { role: string }).role);
  transport.send({
    type: "CUSTOM",
    name: "run",
    value: {
      status: "done",
      result: { status: "ok", reply: "Done" },
      activity: [
        {
          seq: 57,
          parentSeq: null,
          type: "approval_resolved",
          payload: { requestId: "a", command: "help", approved: true, scope: "once" },
          createdAt: 100,
        },
      ],
    },
  });
  await completion;
  assert.ok(beforeCompletion.includes("approval-decision"), JSON.stringify(beforeCompletion));
});
