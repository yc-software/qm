import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createMemoryConfigStore, type PersistedBaseModel } from "../src/resolution/config-store.ts";
import { createMemoryMap, createPostgresMapFactory, type DurableMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const factory = URL ? createPostgresMapFactory(URL) : null;
after(async () => {
  await factory?.pool.close();
});

let tableSeq = 0;
const freshMap = async (): Promise<DurableMap<PersistedBaseModel>> => {
  if (!factory) return createMemoryMap<PersistedBaseModel>();
  const table = `xsrv_base_model_${process.pid}_${tableSeq++}`;
  await factory.pool.query(`DROP TABLE IF EXISTS ${table}`);
  return factory.map<PersistedBaseModel>(table);
};

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
const cron = { harnessId: "pi" as const, modelId: "cron-model" };
const pick = { harnessId: "pi" as const, modelId: "org-model" };

test("an org runtime change on one server keeps a cron runtime another server saved meanwhile", async () => {
  const shared = await freshMap();
  const paused = pausedReads(shared);
  const left = createMemoryConfigStore("default-org", { baseModels: paused.map });
  const right = createMemoryConfigStore("default-org", { baseModels: shared });

  const leftWrite = left.setRuntimeSelectionLatest(org, pick);
  await paused.readStarted;
  await right.setPurposeRuntime("cron", cron);
  paused.release();
  await leftWrite;

  const row = await shared.get(org);
  assert.equal(row?.modelId, "org-model");
  assert.deepEqual(row?.cronRuntime, cron);
});

test("saving a purpose runtime on one server keeps the org runtime another server saved meanwhile", async () => {
  const shared = await freshMap();
  const paused = pausedReads(shared);
  const left = createMemoryConfigStore("default-org", { baseModels: paused.map });
  const right = createMemoryConfigStore("default-org", { baseModels: shared });

  const leftWrite = left.setPurposeRuntime("cron", cron);
  await paused.readStarted;
  await right.setRuntimeSelectionLatest(org, pick);
  paused.release();
  await leftWrite;

  const row = await shared.get(org);
  assert.equal(row?.modelId, "org-model");
  assert.deepEqual(row?.cronRuntime, cron);
});

test("concurrent org runtime changes on two servers get distinct revisions", async () => {
  const shared = await freshMap();
  await shared.put(org, { scopeId: org, harnessId: "pi", modelId: "seed", revision: 1, orgRevision: 1 });
  const paused = pausedReads(shared);
  const left = createMemoryConfigStore("default-org", { baseModels: paused.map });
  const right = createMemoryConfigStore("default-org", { baseModels: shared });

  const leftWrite = left.setRuntimeSelectionLatest(org, pick);
  await paused.readStarted;
  await right.setRuntimeSelectionLatest(org, { harnessId: "pi", modelId: "other" });
  paused.release();
  await leftWrite;

  assert.equal((await shared.get(org))?.revision, 3);
});

test("acknowledging the org runtime on one server keeps a scope runtime another server just chose", async () => {
  const shared = await freshMap();
  const channel = scopeId("channel", "c1");
  await shared.put(channel, { scopeId: channel, harnessId: "pi", modelId: "old", orgRevision: 0 });
  await shared.put(org, { scopeId: org, harnessId: "pi", modelId: "org-model", revision: 4, orgRevision: 4 });
  const paused = pausedReads(shared);
  const left = createMemoryConfigStore("default-org", { baseModels: paused.map });
  const right = createMemoryConfigStore("default-org", { baseModels: shared });

  const ack = left.acknowledgeRuntimeSelectionLatest(channel);
  await paused.readStarted;
  await right.setRuntimeSelectionLatest(channel, { harnessId: "pi", modelId: "new" });
  paused.release();
  await ack;

  const row = await shared.get(channel);
  assert.equal(row?.modelId, "new");
  assert.equal(row?.orgRevision, 4);
});

test("clearing the org runtime keeps purpose runtimes and removes an empty row", async () => {
  const shared = await freshMap();
  const store = createMemoryConfigStore("default-org", { baseModels: shared });
  await store.setRuntimeSelectionLatest(org, pick);
  await store.setPurposeRuntime("cron", cron);
  await store.setRuntimeSelectionLatest(org, null);
  assert.deepEqual(await shared.get(org), { scopeId: org, cronRuntime: cron });
  await store.clearPurposeRuntime("cron");
  assert.equal(await shared.get(org), null);
  assert.equal(store.getRuntimeSelection(org), null);
});
