import assert from "node:assert/strict";
import test from "node:test";
import { createInboxEventCoalescer, type InboxItemRef } from "../src/inbox-coalesce.ts";

function harness() {
  const flushed: InboxItemRef[][] = [];
  const timers: Array<() => void> = [];
  const enqueue = createInboxEventCoalescer(
    250,
    (batch) => flushed.push(batch),
    (fn) => timers.push(fn),
  );
  return { flushed, enqueue, fire: () => timers.splice(0).forEach((fn) => fn()) };
}

test("a burst inside one window flushes every distinct item it touched, not just the first", () => {
  const { flushed, enqueue, fire } = harness();
  for (let i = 1; i <= 10; i++) enqueue({ loopId: "loop-1", itemId: `item-${i}` });
  assert.equal(flushed.length, 0, "nothing flushes before the window closes");
  fire();
  assert.equal(flushed.length, 1, "one burst becomes one flush");
  assert.deepEqual(
    flushed[0]!.map((r) => r.itemId),
    Array.from({ length: 10 }, (_, i) => `item-${i + 1}`),
  );
});

test("repeat events for the same item collapse into one entry", () => {
  const { flushed, enqueue, fire } = harness();
  enqueue({ loopId: "loop-1", itemId: "item-1" });
  enqueue({ loopId: "loop-1", itemId: "item-1" });
  enqueue({ loopId: "loop-1", itemId: "item-2" });
  fire();
  assert.deepEqual(flushed[0], [
    { loopId: "loop-1", itemId: "item-1" },
    { loopId: "loop-1", itemId: "item-2" },
  ]);
});

test("only one timer is armed per window, and the next window starts clean", () => {
  const { flushed, enqueue, fire } = harness();
  enqueue({ loopId: "loop-1", itemId: "a" });
  enqueue({ loopId: "loop-1", itemId: "b" });
  fire();
  enqueue({ loopId: "loop-1", itemId: "c" });
  fire();
  assert.equal(flushed.length, 2);
  assert.deepEqual(
    flushed[1]!.map((r) => r.itemId),
    ["c"],
    "a flushed batch never leaks into the next window",
  );
});

test("items from different loops keep their loop ids through the flush", () => {
  const { flushed, enqueue, fire } = harness();
  enqueue({ loopId: "loop-1", itemId: "x" });
  enqueue({ loopId: "loop-2", itemId: "x" });
  fire();
  assert.deepEqual(flushed[0], [
    { loopId: "loop-1", itemId: "x" },
    { loopId: "loop-2", itemId: "x" },
  ]);
});
