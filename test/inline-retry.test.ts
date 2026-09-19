import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";
import { createWorkCapacity } from "../src/runs/work-capacity.ts";

const request: TurnRequest = {
  surface: "test",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef: "inline-retry" },
  text: "hello",
  idempotencyKey: "inline-retry",
};

for (const laterMessage of [false, true]) {
  test(
    `inline execution waits out backoff without a worker: later message=${laterMessage}`,
    { timeout: 5_000 },
    async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const built = buildApp(testConfig({ runWaitMs: 1_000 }));
      const queued = await built.app.turn({ ...request, async: true });
      const claimed = await built.runs.claimById(queued.runId!, "setup", 60_000);
      await built.runs.fail(claimed!.id, claimed!.leaseToken!, "temporary", { retryAfterMs: 30_000 });
      let settled = false;
      const pending = built.app.turn(laterMessage ? { ...request, text: "next", idempotencyKey: "next" } : request);
      const outcome = pending.then((result) => {
        settled = true;
        return result;
      });
      await sleep(50);
      assert.equal(settled, false);
      assert.equal((await built.runs.get(queued.runId!))?.attempts, 1);
      t.mock.timers.tick(30_000);
      const result = await outcome;
      assert.equal(result.status, "ok");
      assert.match(result.reply!, laterMessage ? /next/ : /hello/);
    },
  );
}

test("inline waiting respects its timeout without clearing a retry deadline", async () => {
  const built = buildApp(testConfig({ runWaitMs: 100 }));
  const queued = await built.app.turn({ ...request, async: true });
  const claimed = await built.runs.claimById(queued.runId!, "setup", 60_000);
  await built.runs.fail(claimed!.id, claimed!.leaseToken!, "temporary", { retryAfterMs: 30_000 });
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(built.app.turn(request), /did not finish within 100ms/);
    assert.equal(await built.runs.claimById(claimed!.id, "other", 60_000), null);
  } finally {
    clearInterval(keepAlive);
  }
});

test("inline waiting returns another worker's result without executing twice", async () => {
  const built = buildApp(testConfig({ runWaitMs: 1_000 }));
  const queued = await built.app.turn({ ...request, async: true });
  const claimed = await built.runs.claimById(queued.runId!, "other", 60_000);
  const pending = built.app.turn(request);
  await sleep(50);
  await built.runs.complete(claimed!.id, claimed!.leaseToken!, { status: "ok", reply: "other worker" });
  assert.equal((await pending).reply, "other worker");
  assert.equal((await built.runs.get(claimed!.id))?.attempts, 1);
});

test("a hosted app with background work disabled executes synchronous turns under tenant and host capacity", async (t) => {
  const capacity = createWorkCapacity(2);
  const firstHostSlot = await capacity.acquire();
  const secondHostSlot = await capacity.acquire();
  const built = buildApp(testConfig({ backgroundWorkEnabled: false, workers: 1, runWaitMs: 2_000 }), { capacity });
  const claim = built.runs.claimForSession.bind(built.runs);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let claims = 0;
  t.mock.method(built.runs, "claimForSession", async (...args: Parameters<typeof claim>) => {
    claims++;
    const run = await claim(...args);
    entered.resolve();
    await finish.promise;
    return run;
  });
  built.runtime.start();
  const first = built.app.turn({
    ...request,
    conversation: { kind: "dm", threadRef: "disabled-first" },
    idempotencyKey: "disabled-first",
  });
  const second = built.app.turn({
    ...request,
    conversation: { kind: "dm", threadRef: "disabled-second" },
    idempotencyKey: "disabled-second",
  });
  try {
    await sleep(20);
    assert.equal(claims, 0);
    firstHostSlot!();
    secondHostSlot!();
    await entered.promise;
    await sleep(20);
    assert.equal(claims, 1);
    finish.resolve();
    const results = await Promise.all([first, second]);
    assert.ok(results.every((result) => result.status === "ok"));
    assert.equal(claims, 2);
  } finally {
    firstHostSlot!();
    secondHostSlot!();
    finish.resolve();
    await Promise.allSettled([first, second]);
    await built.runtime.stop();
  }
  const releasedFirst = await capacity.acquire();
  const releasedSecond = await capacity.acquire();
  releasedFirst!();
  releasedSecond!();
});
