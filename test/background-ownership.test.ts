import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";

async function fixture() {
  const store = createBackgroundOwnershipStore(createMemoryMap<BackgroundOwnership>());
  for (const [instanceId, deploymentId] of [
    ["a1", "a"],
    ["a2", "a"],
    ["b1", "b"],
    ["b2", "b"],
  ])
    await store.register({ instanceId: instanceId!, deploymentId: deploymentId!, taskArn: `task:${instanceId}` });
  await store.admit("a1", 0, true);
  await store.admit("a2", 0, true);
  const bootstrap = {
    expectedGeneration: 0,
    requestId: "bootstrap",
    desiredDeploymentId: "a",
    bootstrapTaskArns: ["task:a1", "task:a2", "task:b1", "task:b2"],
  };
  return { store, bootstrap };
}

test("bootstrap preserves legacy work until every old replica acknowledges relinquishment", async () => {
  const { store, bootstrap } = await fixture();
  assert.equal((await store.get()).enabled, false);
  await assert.rejects(store.admit("b1", 0, false), /disabled/);
  await assert.rejects(store.transition({ ...bootstrap, bootstrapTaskArns: ["task:a1"] }), /cohort/);
  await store.transition(bootstrap);
  await assert.rejects(store.admit("a1", 1, true), /Previous owners/);
  await store.acknowledge("a1", 0, "relinquished");
  await assert.rejects(store.admit("a1", 1, true), /Previous owners/);
  await store.acknowledge("a2", 0, "relinquished");
  await Promise.all([store.admit("a1", 1, true), store.admit("a2", 1, true)]);
  assert.equal((await store.get()).members.filter((member) => member.state === "admitted").length, 2);
});

test("generation CAS and replay identity fence stale transitions and admissions", async () => {
  const { store, bootstrap } = await fixture();
  await store.transition(bootstrap);
  assert.equal((await store.transition(bootstrap)).generation, 1);
  await assert.rejects(store.transition({ ...bootstrap, requestId: "different" }), /generation changed/);
  await assert.rejects(store.transition({ ...bootstrap, desiredDeploymentId: "b" }), /identity reused/);
  await assert.rejects(store.admit("a1", 0, true), /generation changed/);
  await assert.rejects(store.admit("b1", 1, true), /not the desired/);
});

test("handover permits previous turns to drain after new deployment starts and supports rollback", async () => {
  const { store, bootstrap } = await fixture();
  await store.transition(bootstrap);
  for (const id of ["a1", "a2"]) await store.acknowledge(id, 0, "relinquished");
  for (const id of ["a1", "a2"]) await store.admit(id, 1, true);
  await store.transition({ expectedGeneration: 1, requestId: "to-b", desiredDeploymentId: "b" });
  for (const id of ["a1", "a2"]) await store.acknowledge(id, 1, "relinquished");
  for (const id of ["b1", "b2"]) await store.admit(id, 2, false);
  assert.equal((await store.get()).members.find((member) => member.instanceId === "a1")?.state, "relinquished");
  await store.transition({ expectedGeneration: 2, requestId: "rollback", desiredDeploymentId: "a" });
  await assert.rejects(store.admit("a1", 3, true), /Previous owners/);
  for (const id of ["b1", "b2"]) await store.acknowledge(id, 2, "relinquished");
  await store.admit("a1", 3, true);
  await assert.rejects(store.acknowledge("a1", 1, "drained"), /admission changed/);
  assert.equal((await store.get()).members.find((member) => member.instanceId === "a1")?.state, "admitted");
});

test("only exact explicit termination evidence retires disconnected members and blocks task resurrection", async () => {
  const { store, bootstrap } = await fixture();
  await store.transition(bootstrap);
  await store.acknowledge("a1", 0, "relinquished");
  await assert.rejects(store.admit("a1", 1, true), /Previous owners/);
  const proof = { instanceId: "a2", taskArn: "task:a2", generation: 0 };
  for (const wrong of [
    { ...proof, taskArn: "other" },
    { ...proof, generation: 1 },
    { ...proof, instanceId: "other" },
  ])
    await assert.rejects(
      store.retire({ expectedGeneration: 1, requestId: "retire", terminatedMembers: [wrong] }),
      /evidence/,
    );
  await store.retire({ expectedGeneration: 1, requestId: "retire", terminatedMembers: [proof] });
  await store.admit("a1", 1, true);
  await assert.rejects(store.register({ instanceId: "new-process", deploymentId: "a", taskArn: "task:a2" }), /retired/);
  await assert.rejects(store.admit("a2", 1, true), /retired/);
});

test("pause has no successor and failed admissions never mutate ownership", async () => {
  const { store, bootstrap } = await fixture();
  await store.transition({ ...bootstrap, desiredDeploymentId: null });
  const before = await store.get();
  await assert.rejects(store.admit("a1", 1, true), /not the desired/);
  assert.deepEqual(await store.get(), before);
  for (const id of ["a1", "a2"]) {
    await store.acknowledge(id, 0, "relinquished");
    await store.acknowledge(id, 0, "drained");
  }
  assert.ok((await store.get()).members.every((member) => member.state === "drained"));
});
