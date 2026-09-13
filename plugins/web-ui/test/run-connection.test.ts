import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRunResumeStreamFn } from "../src/core-bridge.ts";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

const model = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

class FakeEventSource extends EventTarget {
  static current: FakeEventSource;
  onopen?: () => void;
  onerror?: () => void;
  closed = false;
  constructor() {
    super();
    FakeEventSource.current = this;
  }
  close() {
    this.closed = true;
  }
}

for (const heartbeat of [false, true]) {
  test(`a silent established stream falls back to polling${heartbeat ? " after its last heartbeat" : ""}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, "EventSource", original);
      else Reflect.deleteProperty(globalThis, "EventSource");
    });
    let polls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      polls++;
      return Response.json({ status: "done", result: { status: "ok", stopped: true } });
    });
    const stream = await makeRunResumeStreamFn("r")(model, {} as Context, {});
    await flush();
    const es = FakeEventSource.current;
    es.onopen?.();
    if (heartbeat) {
      t.mock.timers.tick(20_000);
      es.dispatchEvent(new Event("alive"));
      t.mock.timers.tick(20_000);
      await flush();
      assert.equal(polls, 0);
    }
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(polls, 1);
    assert.equal(es.closed, true);
    assert.equal((await stream.result()).stopReason, "aborted");
    t.mock.timers.tick(60_000);
    assert.equal(polls, 1);
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
  assert.ok(requestSignal, "poll requests must be bounded");
  timeout.abort(new DOMException("timed out", "TimeoutError"));
  await flush();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(polls, 2);
  assert.equal((await stream.result()).stopReason, "stop");
});

for (const terminal of [true, false]) {
  test(`${terminal ? "terminal completion" : "detaching"} cancels the connection watchdog`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, "EventSource", original);
      else Reflect.deleteProperty(globalThis, "EventSource");
    });
    let polls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      polls++;
      return Response.json({ status: "done", result: { status: "ok" } });
    });
    const controller = new AbortController();
    const stream = await makeRunResumeStreamFn("r")(model, {} as Context, { signal: controller.signal });
    await flush();
    const es = FakeEventSource.current;
    es.onopen?.();
    if (terminal) {
      const event = new Event("done");
      Object.assign(event, { data: JSON.stringify({ status: "done", result: { status: "ok" } }) });
      es.dispatchEvent(event);
    } else controller.abort();
    await stream.result();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(es.closed, true);
    assert.equal(polls, 0);
  });
}
