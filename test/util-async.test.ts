import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { sleep, createKeyedQueue } from "../src/util/async.ts";

test("sleep resolves after roughly the given delay", async () => {
  const t0 = Date.now();
  await sleep(20);
  assert.ok(Date.now() - t0 >= 15, "waited at least most of the delay");
});

test("createKeyedQueue runs ops on one key strictly in submission order", async () => {
  const run = createKeyedQueue();
  const order: string[] = [];
  const op = (name: string, ms: number) =>
    run("k", async () => {
      order.push(`${name}:start`);
      await sleep(ms);
      order.push(`${name}:end`);
      return name;
    });
  const results = await Promise.all([op("a", 25), op("b", 5), op("c", 0)]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  assert.deepEqual(results, ["a", "b", "c"], "each caller gets its own op's result");
});

test("createKeyedQueue lets independent keys interleave", async () => {
  const run = createKeyedQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slow = run("a", async () => {
    order.push("a:start");
    await gate;
    order.push("a:end");
  });
  await run("b", async () => {
    order.push("b");
  });
  assert.deepEqual(order, ["a:start", "b"], "b completed while a was still in flight");
  release();
  await slow;
});

test("createKeyedQueue delivers a rejection to its caller without breaking the chain", async () => {
  const run = createKeyedQueue();
  const order: string[] = [];
  const first = run("k", async () => {
    order.push("first");
  });
  const middle = run("k", async () => {
    order.push("middle");
    throw new Error("boom");
  });
  const last = run("k", async () => {
    order.push("last");
    return "ok";
  });
  await first;
  await assert.rejects(middle, /boom/);
  assert.equal(await last, "ok", "the op after a failure still runs and resolves");
  assert.deepEqual(order, ["first", "middle", "last"]);
});

test("createKeyedQueue keeps working on a key after it drains", async () => {
  const run = createKeyedQueue<string>();
  const order: string[] = [];
  await run("k", async () => {
    order.push("a");
  });
  await sleep(5);
  const b = run("k", async () => {
    order.push("b");
    await sleep(10);
  });
  const c = run("k", async () => {
    order.push("c");
  });
  await Promise.all([b, c]);
  assert.deepEqual(order, ["a", "b", "c"], "a fresh chain on the same key still serializes");
});

test("createKeyedQueue ops queued at drain time are not lost to the cleanup race", async () => {
  const run = createKeyedQueue<string>();
  const order: string[] = [];
  const first = run("k", async () => {
    order.push("first");
  });
  const second = first.then(() =>
    run("k", async () => {
      order.push("second");
      return "ok";
    }),
  );
  assert.equal(await second, "ok");
  assert.deepEqual(order, ["first", "second"]);
});
