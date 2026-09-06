import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEventBus } from "../src/util/event-bus.ts";

test("memory bus: resync rings every subscriber's onResync hook and tolerates a throwing one", () => {
  const bus = createMemoryEventBus<string>("t");
  const rung: string[] = [];
  bus.subscribe(() => {}, {
    onResync: () => {
      throw new Error("boom");
    },
  });
  bus.subscribe(() => {}, { onResync: () => rung.push("b") });
  const off = bus.subscribe(() => {}, { onResync: () => rung.push("c") });
  assert.equal(bus.size(), 3);
  bus.resync();
  assert.deepEqual(rung, ["b", "c"]);
  off();
  bus.resync();
  assert.deepEqual(rung, ["b", "c", "b"], "an unsubscribed hook is not rung");
  assert.equal(bus.size(), 2);
});

test("memory bus: a subscriber without an onResync hook is skipped by resync", () => {
  const bus = createMemoryEventBus<number>("t");
  const got: number[] = [];
  bus.subscribe((n) => got.push(n));
  bus.resync();
  bus.emit(1);
  assert.deepEqual(got, [1]);
});
