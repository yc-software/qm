import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

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
