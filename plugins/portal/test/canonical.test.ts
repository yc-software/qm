import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createCanonicalResolver } from "../src/canonical.ts";

function harness(answers: Array<string | null | Error>) {
  const calls: string[] = [];
  const settled: Array<Promise<unknown>> = [];
  const resolve = createCanonicalResolver((sub) => {
    calls.push(sub);
    const next = answers.shift();
    const answer = next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? null);
    settled.push(answer.catch(() => null));
    return answer;
  });
  const idle = async () => {
    await Promise.all(settled);
    await new Promise((r) => setImmediate(r));
  };
  return { resolve, calls, idle };
}

test.beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_000_000 }));
test.afterEach(() => mock.timers.reset());

test("a failed lookup with no earlier answer reports the identity as unavailable", async () => {
  const { resolve } = harness([null, new Error("timeout")]);
  assert.equal(await resolve("U-alias"), null);
  assert.equal(await resolve("U-alias"), null);
});

test("a stale answer is served while the refresh runs, then replaced by the refreshed one", async () => {
  const { resolve, calls, idle } = harness(["U1", new Error("The operation was aborted due to timeout"), "U2"]);
  assert.deepEqual(await resolve("U-alias"), { id: "U1", stale: false });
  mock.timers.tick(30_000);
  assert.deepEqual(await resolve("U-alias"), { id: "U1", stale: false });
  assert.equal(calls.length, 1);
  mock.timers.tick(31_000);
  assert.deepEqual(await resolve("U-alias"), { id: "U1", stale: true });
  await idle();
  assert.deepEqual(await resolve("U-alias"), { id: "U1", stale: true });
  await idle();
  assert.deepEqual(await resolve("U-alias"), { id: "U2", stale: false });
  assert.equal(calls.length, 3);
});

test("a last known answer stops being reused five minutes after core last confirmed it", async () => {
  const { resolve, idle } = harness(["U1", null, null, null]);
  assert.deepEqual(await resolve("U-alias"), { id: "U1", stale: false });
  mock.timers.tick(2 * 60_000);
  assert.deepEqual(await resolve("U-alias"), { id: "U1", stale: true });
  await idle();
  mock.timers.tick(2 * 60_000);
  assert.deepEqual(await resolve("U-alias"), { id: "U1", stale: true });
  await idle();
  mock.timers.tick(60_000 + 1);
  assert.equal(await resolve("U-alias"), null);
});

test("concurrent stale reads share one background lookup", async () => {
  const { resolve, calls } = harness(["U1", "U1"]);
  await resolve("U-alias");
  mock.timers.tick(61_000);
  await Promise.all([resolve("U-alias"), resolve("U-alias"), resolve("U-alias")]);
  assert.equal(calls.length, 2);
});
