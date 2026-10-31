import assert from "node:assert/strict";
import test from "node:test";
import {
  createBackgroundOwnershipStore,
  createBackgroundOwnershipRows,
  type BackgroundOwnership,
} from "../src/runs/background-ownership.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("a fresh record has no owner and the first set records who set it and when", async () => {
  const store = createBackgroundOwnershipStore(createBackgroundOwnershipRows(testDatabaseUrl()));
  assert.deepEqual(await store.get(), { ownerDeploymentId: null, setAt: null, setBy: null });
  const before = Date.now();
  const state = await store.set({ ownerDeploymentId: "a", setBy: "a" });
  assert.equal(state.ownerDeploymentId, "a");
  assert.equal(state.setBy, "a");
  assert.ok(Date.parse(state.setAt!) >= before);
  assert.deepEqual(await store.get(), state);
});

test("compare-and-swap refuses a stale expectation but accepts an idempotent retry", async () => {
  const store = createBackgroundOwnershipStore(createBackgroundOwnershipRows(testDatabaseUrl()));
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

function memoryRows() {
  let row: BackgroundOwnership | null = null;
  return {
    get: async () => row,
    putIfAbsent: async (_key: string, value: BackgroundOwnership) => (row ??= value),
    update: async (_key: string, fn: (stored: BackgroundOwnership) => BackgroundOwnership) => (row = fn(row!)),
  };
}

test("a never-set record is claimed once, and an operator's owner or pause is never overridden", async () => {
  const fresh = createBackgroundOwnershipStore(memoryRows());
  const claimed = await fresh.claimIfNeverSet("first");
  assert.equal(claimed.ownerDeploymentId, "first");
  assert.equal(claimed.setBy, "first");
  assert.deepEqual(await fresh.claimIfNeverSet("second"), claimed);
  const paused = createBackgroundOwnershipStore(memoryRows());
  await paused.set({ ownerDeploymentId: "chosen", setBy: "operator" });
  const stopped = await paused.set({ ownerDeploymentId: null, expectedOwnerDeploymentId: "chosen", setBy: "operator" });
  assert.deepEqual(await paused.claimIfNeverSet("intruder"), stopped);
  const owned = createBackgroundOwnershipStore(memoryRows());
  const chosen = await owned.set({ ownerDeploymentId: "chosen", setBy: "operator" });
  assert.deepEqual(await owned.claimIfNeverSet("intruder"), chosen);
});
