import { test } from "node:test";
import assert from "node:assert/strict";
import { type PersistedBaseModel } from "../src/resolution/config-store.ts";
import { type DurableMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import { testConfigStore, testMap } from "./support/test-database.ts";

const pausedReads = (map: DurableMap<PersistedBaseModel>) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const readStarted = new Promise<void>((resolve) => (reached = resolve));
  let armed = true;
  const wrapped: DurableMap<PersistedBaseModel> = {
    ...map,
    async get(id) {
      const row = await map.get(id);
      if (armed) {
        armed = false;
        reached();
        await gate;
      }
      return row;
    },
    async update(id, fn) {
      if (!armed) return map.update!(id, fn);
      armed = false;
      reached();
      await gate;
      return map.update!(id, fn);
    },
  };
  return { map: wrapped, release, readStarted };
};

const org = scopeId("org", "default-org");
const cron = { modelId: "cron-model" };
const pick = { modelId: "org-model" };

test("an org runtime change on one server keeps a cron runtime another server saved meanwhile", async () => {
  const shared = testMap<PersistedBaseModel>();
  const paused = pausedReads(shared);
  const left = testConfigStore("default-org", { baseModels: paused.map });
  const right = testConfigStore("default-org", { baseModels: shared });

  const leftWrite = left.setRuntimeSelection(org, pick);
  await paused.readStarted;
  await right.setPurposeRuntime("cron", cron);
  paused.release();
  await leftWrite;

  const row = await shared.get(org);
  assert.equal(row?.modelId, "org-model");
  assert.deepEqual(row?.cronRuntime, cron);
});

test("saving a purpose runtime on one server keeps the org runtime another server saved meanwhile", async () => {
  const shared = testMap<PersistedBaseModel>();
  const paused = pausedReads(shared);
  const left = testConfigStore("default-org", { baseModels: paused.map });
  const right = testConfigStore("default-org", { baseModels: shared });

  const leftWrite = left.setPurposeRuntime("cron", cron);
  await paused.readStarted;
  await right.setRuntimeSelection(org, pick);
  paused.release();
  await leftWrite;

  const row = await shared.get(org);
  assert.equal(row?.modelId, "org-model");
  assert.deepEqual(row?.cronRuntime, cron);
});

test("concurrent org runtime changes on two servers get distinct revisions", async () => {
  const shared = testMap<PersistedBaseModel>();
  await shared.put(org, { scopeId: org, modelId: "seed", revision: 1, orgRevision: 1 });
  const paused = pausedReads(shared);
  const left = testConfigStore("default-org", { baseModels: paused.map });
  const right = testConfigStore("default-org", { baseModels: shared });

  const leftWrite = left.setRuntimeSelection(org, pick);
  await paused.readStarted;
  await right.setRuntimeSelection(org, { modelId: "other" });
  paused.release();
  await leftWrite;

  assert.equal((await shared.get(org))?.revision, 3);
});

test("acknowledging the org runtime on one server keeps a scope runtime another server just chose", async () => {
  const shared = testMap<PersistedBaseModel>();
  const channel = scopeId("channel", "c1");
  await shared.put(channel, { scopeId: channel, modelId: "old", orgRevision: 0 });
  await shared.put(org, { scopeId: org, modelId: "org-model", revision: 4, orgRevision: 4 });
  const paused = pausedReads(shared);
  const left = testConfigStore("default-org", { baseModels: paused.map });
  const right = testConfigStore("default-org", { baseModels: shared });

  const ack = left.acknowledgeRuntimeSelection(channel);
  await paused.readStarted;
  await right.setRuntimeSelection(channel, { modelId: "new" });
  paused.release();
  await ack;

  const row = await shared.get(channel);
  assert.equal(row?.modelId, "new");
  assert.equal(row?.orgRevision, 4);
});

test("clearing the org runtime keeps purpose runtimes and removes an empty row", async () => {
  const shared = testMap<PersistedBaseModel>();
  const store = testConfigStore("default-org", { baseModels: shared });
  await store.setRuntimeSelection(org, pick);
  await store.setPurposeRuntime("cron", cron);
  await store.setRuntimeSelection(org, null);
  assert.deepEqual(await shared.get(org), { scopeId: org, cronRuntime: cron });
  await store.clearPurposeRuntime("cron");
  assert.equal(await shared.get(org), null);
  assert.equal(store.getRuntimeSelection(org), null);
});
