import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createCanonicalResolver } from "../src/canonical.ts";

function harness(answers: Array<string | null | Error>) {
  const calls: string[] = [];
  const resolve = createCanonicalResolver(async (sub) => {
    calls.push(sub);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? null;
  });
  return { resolve, calls };
}

test.beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_000_000 }));
test.afterEach(() => mock.timers.reset());

test("a failed lookup with no earlier answer reports the identity as unavailable", async () => {
  const { resolve } = harness([null, new Error("timeout")]);
  assert.equal(await resolve("U-alias"), null);
  assert.equal(await resolve("U-alias"), null);
});

test("a stale answer is served while the refresh runs, then replaced by the refreshed one", async () => {
  const { resolve, calls } = harness(["U1", new Error("The operation was aborted due to timeout"), "U2"]);
  assert.equal(await resolve("U-alias"), "U1");
  mock.timers.tick(30_000);
  assert.equal(await resolve("U-alias"), "U1");
  assert.equal(calls.length, 1);
  mock.timers.tick(31_000);
  assert.equal(await resolve("U-alias"), "U1");
  await new Promise((r) => setImmediate(r));
  assert.equal(await resolve("U-alias"), "U1");
  await new Promise((r) => setImmediate(r));
  assert.equal(await resolve("U-alias"), "U2");
  assert.equal(calls.length, 3);
});

test("a last known answer older than five minutes is not reused", async () => {
  const { resolve } = harness(["U1", null]);
  assert.equal(await resolve("U-alias"), "U1");
  mock.timers.tick(5 * 60_000 + 1);
  assert.equal(await resolve("U-alias"), null);
});

test("concurrent stale reads share one background lookup", async () => {
  const { resolve, calls } = harness(["U1", "U1"]);
  await resolve("U-alias");
  mock.timers.tick(61_000);
  await Promise.all([resolve("U-alias"), resolve("U-alias"), resolve("U-alias")]);
  assert.equal(calls.length, 2);
});
