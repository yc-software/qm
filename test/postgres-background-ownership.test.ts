import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";
import { isolatedPostgres } from "./support/isolated-postgres.ts";

const databaseUrl = process.env.DATABASE_URL;
test("Postgres serializes concurrent ownership transitions and replica admission", { skip: !databaseUrl }, async () => {
  const table = `background_test_${randomUUID().replaceAll("-", "")}`;
  const factories = [createPostgresMapFactory(databaseUrl!), createPostgresMapFactory(databaseUrl!)];
  try {
    const stores = factories.map((factory) => createBackgroundOwnershipStore(factory.map<BackgroundOwnership>(table)));
    await Promise.all(
      stores.map((store, i) => store.register({ instanceId: `a${i}`, deploymentId: "a", taskArn: `task:a${i}` })),
    );
    await Promise.all(stores.map((store, i) => store.admit(`a${i}`, 0, true)));
    const transitions = await Promise.allSettled(
      stores.map((store) =>
        store.transition({
          expectedGeneration: 0,
          requestId: randomUUID(),
          desiredDeploymentId: "a",
          bootstrapTaskArns: ["task:a0", "task:a1"],
        }),
      ),
    );
    assert.equal(transitions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(transitions.filter((result) => result.status === "rejected").length, 1);
    await assert.rejects(stores[0]!.admit("a0", 1, true), /Previous owners/);
    await Promise.all(stores.map((store, i) => store.acknowledge(`a${i}`, 0, "relinquished")));
    await Promise.all(stores.map((store, i) => store.admit(`a${i}`, 1, true)));
    const state = await stores[0]!.get();
    assert.equal(state.members.filter((member) => member.state === "admitted" && member.generation === 1).length, 2);
    assert.deepEqual(await stores[1]!.get(), state);
  } finally {
    const pool = await factories[0]!.pool.pool();
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
    await Promise.all(factories.map((factory) => factory.pool.close()));
  }
});

test(
  "Postgres workflow workers resume claims while an earlier worker drains",
  { skip: !databaseUrl, timeout: 20_000 },
  async (t) => {
    const { createDurableTasks } = await import("../src/durable/tasks.ts");
    const db = await isolatedPostgres();
    t.after(() => db.cleanup());
    const queueName = `handover_${randomUUID().replaceAll("-", "")}`;
    const tasks = createDurableTasks({ databaseUrl: db.url, queue: queueName });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let finished = false;
    tasks.register<{ old: boolean }, void>("handover", async (_context, input) => {
      if (input.old) {
        entered.resolve();
        await finish.promise;
        finished = true;
      }
    });
    const first = tasks.start({ concurrency: 1, pollIntervalMs: 10 });
    try {
      const old = await tasks.spawn("handover", { old: true }, { idempotencyKey: "old" });
      await entered.promise;
      await first.stopClaims();
      assert.equal(finished, false);
      const second = tasks.start({ concurrency: 1, pollIntervalMs: 10 });
      try {
        const next = await tasks.spawn("handover", { old: false }, { idempotencyKey: "next" });
        await tasks.result(next.taskId);
        assert.equal(finished, false);
        finish.resolve();
        await tasks.result(old.taskId);
      } finally {
        await second.stop();
      }
    } finally {
      finish.resolve();
      await first.stop();
      await tasks.close();
    }
  },
);
