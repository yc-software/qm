import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";

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
