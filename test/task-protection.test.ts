import { test } from "node:test";
import assert from "node:assert/strict";
import { createEcsTaskProtection } from "../src/runs/task-protection.ts";

test("tenants sharing an ECS task retain protection until the final owner releases it", async () => {
  const writes: boolean[] = [];
  const fetchFn: typeof fetch = async (_url, options) => {
    writes.push((JSON.parse(String(options?.body)) as { ProtectionEnabled: boolean }).ProtectionEnabled);
    return new Response("{}", { status: 200 });
  };
  const first = createEcsTaskProtection("http://task-protection/tenants/", { fetchFn });
  const second = createEcsTaskProtection("http://task-protection/tenants", { fetchFn });
  await first.set(true);
  await second.set(true);
  await first.set(false);
  assert.ok(writes.every(Boolean));
  await second.set(false);
  assert.equal(writes.at(-1), false);
});

test("concurrent tenant protection changes coalesce and a delayed release cannot clear a new owner", async () => {
  const releaseStarted = Promise.withResolvers<void>();
  const finishRelease = Promise.withResolvers<void>();
  const writes: boolean[] = [];
  let block = false;
  let active = 0;
  let maxActive = 0;
  const fetchFn: typeof fetch = async (_url, options) => {
    const enabled = (JSON.parse(String(options?.body)) as { ProtectionEnabled: boolean }).ProtectionEnabled;
    writes.push(enabled);
    active++;
    maxActive = Math.max(maxActive, active);
    if (block && !enabled) {
      releaseStarted.resolve();
      await finishRelease.promise;
    }
    active--;
    return new Response("{}", { status: 200 });
  };
  const first = createEcsTaskProtection("http://task-protection/order", { fetchFn });
  const second = createEcsTaskProtection("http://task-protection/order", { fetchFn });
  await Promise.all([first.set(true), second.set(true)]);
  assert.deepEqual(writes, [true]);
  await second.set(false);
  block = true;
  const releasing = first.set(false);
  await releaseStarted.promise;
  const enabling = second.set(true);
  finishRelease.resolve();
  await Promise.all([releasing, enabling]);
  assert.equal(writes.at(-1), true);
  assert.equal(maxActive, 1);
  await second.set(false);
  assert.equal(writes.at(-1), false);
});

test("a failed final release is retried after all tenant drain controllers have stopped", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failures = 1;
  const retried = Promise.withResolvers<void>();
  const writes: boolean[] = [];
  const protection = createEcsTaskProtection("http://task-protection/retry", {
    fetchFn: async (_url, options) => {
      const enabled = (JSON.parse(String(options?.body)) as { ProtectionEnabled: boolean }).ProtectionEnabled;
      writes.push(enabled);
      if (!enabled && failures-- > 0) throw new Error("temporary failure");
      if (!enabled) retried.resolve();
      return new Response("{}", { status: 200 });
    },
  });
  await protection.set(true);
  await protection.set(false);
  assert.deepEqual(writes, [true, false]);
  t.mock.timers.tick(1_000);
  await retried.promise;
  await protection.set(false);
  assert.equal(writes.at(-1), false);
  assert.equal(writes.filter((value) => !value).length, 2);
});
