import assert from "node:assert/strict";
import { test } from "node:test";
import { createDurableTasks } from "../src/durable/tasks.ts";

test("durable cron workers stop claims while accepted work drains", async () => {
  const tasks = createDurableTasks({ queue: "qm_triggers" });
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const calls: string[] = [];
  tasks.register<{ id: string }, void>("cron.test", async (_context, input) => {
    calls.push(input.id);
    if (input.id === "old") {
      entered.resolve();
      await finish.promise;
    }
  });
  const first = tasks.start({ concurrency: 1 });
  const old = await tasks.spawn("cron.test", { id: "old" }, { idempotencyKey: "old" });
  await entered.promise;
  await first.stopClaims();
  const next = await tasks.spawn("cron.test", { id: "new" }, { idempotencyKey: "new" });
  const second = tasks.start({ concurrency: 1 });
  try {
    await tasks.result(next.taskId);
    assert.deepEqual(calls, ["old", "new"]);
    finish.resolve();
    await tasks.result(old.taskId);
    await first.drained();
  } finally {
    finish.resolve();
    await first.stop();
    await second.stop();
  }
});
