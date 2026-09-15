import assert from "node:assert/strict";
import test from "node:test";
import { lazyModule } from "../src/lazy-module.ts";

test("a rejected lazy load can be retried and then stays memoized", async () => {
  let attempts = 0;
  const module = lazyModule(async () => {
    attempts++;
    if (attempts === 1) throw new Error("chunk unavailable");
    return { value: 42 };
  });

  await assert.rejects(module.load(), /chunk unavailable/);
  assert.equal(module.loaded(), null);
  assert.deepEqual(await module.load(), { value: 42 });
  assert.deepEqual(await module.load(), { value: 42 });
  assert.equal(attempts, 2);
});

test("reset only touches a module that has already loaded", async () => {
  let resets = 0;
  const module = lazyModule(
    async () => ({ value: 1 }),
    () => resets++,
  );

  module.reset();
  assert.equal(resets, 0);
  await module.load();
  module.reset();
  assert.equal(resets, 1);
});
