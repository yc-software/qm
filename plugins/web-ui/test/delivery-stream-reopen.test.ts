import { test } from "node:test";
import assert from "node:assert/strict";
import { subscribeDeliveries } from "../src/core-bridge.ts";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

test("the delivery stream reopens after the browser gives up on it (e.g. a 502 during a deploy) and resyncs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const g = globalThis as { EventSource?: unknown };
  const previous = g.EventSource;
  g.EventSource = FakeEventSource;
  FakeEventSource.instances = [];
  let resyncs = 0;
  try {
    const stop = subscribeDeliveries(
      () => {},
      () => {},
      () => resyncs++,
    );
    const first = FakeEventSource.instances[0]!;
    first.readyState = FakeEventSource.OPEN;
    first.onopen?.();

    first.readyState = FakeEventSource.CONNECTING;
    first.onerror?.();
    t.mock.timers.tick(60_000);
    assert.equal(FakeEventSource.instances.length, 1, "the browser's own retry is left alone");

    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    t.mock.timers.tick(999);
    assert.equal(FakeEventSource.instances.length, 1);
    t.mock.timers.tick(1);
    assert.equal(FakeEventSource.instances.length, 2, "a fresh stream is opened after 1s");
    const second = FakeEventSource.instances[1]!;

    second.readyState = FakeEventSource.CLOSED;
    second.onerror?.();
    t.mock.timers.tick(1_999);
    assert.equal(FakeEventSource.instances.length, 2);
    t.mock.timers.tick(1);
    assert.equal(FakeEventSource.instances.length, 3, "backs off to 2s on a second failure");
    const third = FakeEventSource.instances[2]!;
    third.readyState = FakeEventSource.OPEN;
    third.onopen?.();
    assert.equal(resyncs, 1, "missed session state is resynced on reopen");

    stop();
    third.readyState = FakeEventSource.CLOSED;
    third.onerror?.();
    t.mock.timers.tick(60_000);
    assert.equal(FakeEventSource.instances.length, 3, "no reopen after unsubscribe");
  } finally {
    g.EventSource = previous;
  }
});
