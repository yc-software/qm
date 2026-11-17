import assert from "node:assert/strict";
import { test } from "node:test";
import { subscribeDeliveries } from "../src/core-bridge.ts";

test("a page parked in the back/forward cache frees its delivery stream and resyncs on return", () => {
  const streams: { closed: boolean; onopen: (() => void) | null }[] = [];
  class FakeEventSource {
    closed = false;
    onopen: (() => void) | null = null;
    constructor() {
      streams.push(this);
    }
    addEventListener(): void {}
    close(): void {
      this.closed = true;
    }
  }
  const page = new EventTarget();
  const transition = (type: string): boolean => page.dispatchEvent(Object.assign(new Event(type), { persisted: true }));
  Object.assign(globalThis, { EventSource: FakeEventSource, window: page });
  let resyncs = 0;
  subscribeDeliveries(
    () => {},
    undefined,
    () => resyncs++,
  );
  streams[0]!.onopen?.();
  transition("pagehide");
  assert.equal(streams[0]!.closed, true);
  transition("pageshow");
  streams[1]!.onopen?.();
  assert.deepEqual([streams.length, streams[1]!.closed, resyncs], [2, false, 1]);
});
