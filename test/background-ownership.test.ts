import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";

test("a fresh record has no owner and the first set records who set it and when", async () => {
  const store = createBackgroundOwnershipStore(createMemoryMap<BackgroundOwnership>());
  assert.deepEqual(await store.get(), { ownerDeploymentId: null, setAt: null, setBy: null });
  const before = Date.now();
  const state = await store.set({ ownerDeploymentId: "a", setBy: "a" });
  assert.equal(state.ownerDeploymentId, "a");
  assert.equal(state.setBy, "a");
  assert.ok(Date.parse(state.setAt!) >= before);
  assert.deepEqual(await store.get(), state);
});

test("compare-and-swap refuses a stale expectation but accepts an idempotent retry", async () => {
  const store = createBackgroundOwnershipStore(createMemoryMap<BackgroundOwnership>());
  await store.set({ ownerDeploymentId: "a", setBy: "a" });
  await assert.rejects(store.set({ ownerDeploymentId: "b", expectedOwnerDeploymentId: null, setBy: "b" }), /changed/);
  assert.equal((await store.get()).ownerDeploymentId, "a");
  const handover = await store.set({ ownerDeploymentId: "b", expectedOwnerDeploymentId: "a", setBy: "b" });
  assert.equal(handover.ownerDeploymentId, "b");
  const retried = await store.set({ ownerDeploymentId: "b", expectedOwnerDeploymentId: "a", setBy: "b" });
  assert.deepEqual(retried, handover);
  const paused = await store.set({ ownerDeploymentId: null, expectedOwnerDeploymentId: "b", setBy: "b" });
  assert.equal(paused.ownerDeploymentId, null);
  assert.equal(paused.setBy, "b");
});

test("a member-protocol record is read as its enabled desired owner and stays readable by that protocol", async () => {
  const map = createMemoryMap<BackgroundOwnership>();
  const legacy = {
    enabled: true,
    generation: 7,
    desiredDeploymentId: "core:blue",
    lastRequestId: "request",
    lastRequest: "fingerprint",
    members: [{ instanceId: "i", deploymentId: "core:blue", state: "admitted" }],
  };
  await map.put("ownership", structuredClone(legacy) as unknown as BackgroundOwnership);
  const store = createBackgroundOwnershipStore(map);
  assert.deepEqual(await store.get(), { ownerDeploymentId: "core:blue", setAt: null, setBy: null });
  assert.deepEqual(await map.get("ownership"), legacy);
  await store.set({ ownerDeploymentId: "core:blue", setBy: "core:blue" });
  assert.deepEqual(await map.get("ownership"), legacy);
  await assert.rejects(
    store.set({ ownerDeploymentId: "core:green", expectedOwnerDeploymentId: null, setBy: "core:green" }),
    /changed/,
  );
  const migrated = await store.set({
    ownerDeploymentId: "core:green",
    expectedOwnerDeploymentId: "core:blue",
    setBy: "core:green",
  });
  assert.equal(migrated.ownerDeploymentId, "core:green");
  assert.deepEqual(await map.get("ownership"), {
    ...migrated,
    enabled: true,
    generation: 7,
    desiredDeploymentId: "core:green",
    lastRequestId: null,
    lastRequest: null,
    members: legacy.members,
  });
  await map.put("ownership", { ...legacy, enabled: false } as unknown as BackgroundOwnership);
  assert.equal((await store.get()).ownerDeploymentId, null);
});

test("a member-protocol transition written after the owner record wins until the next owner change", async () => {
  const map = createMemoryMap<BackgroundOwnership>();
  const store = createBackgroundOwnershipStore(map);
  await store.set({ ownerDeploymentId: "core:green", setBy: "core:green" });
  const stored = (await map.get("ownership")) as unknown as Record<string, unknown>;
  await map.put("ownership", {
    ...stored,
    generation: 1,
    desiredDeploymentId: "core:blue",
  } as unknown as BackgroundOwnership);
  assert.equal((await store.get()).ownerDeploymentId, "core:blue");
  await map.put("ownership", { ...stored, generation: 1, desiredDeploymentId: null } as unknown as BackgroundOwnership);
  assert.equal((await store.get()).ownerDeploymentId, null);
  await assert.rejects(
    store.set({ ownerDeploymentId: "core:green", expectedOwnerDeploymentId: "core:green", setBy: "core:green" }),
    /changed/,
  );
  const reclaimed = await store.set({ ownerDeploymentId: "core:green", expectedOwnerDeploymentId: null, setBy: "x" });
  assert.equal(reclaimed.ownerDeploymentId, "core:green");
  assert.equal(((await map.get("ownership")) as unknown as Record<string, unknown>).desiredDeploymentId, "core:green");
});
