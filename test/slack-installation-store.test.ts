import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { createMemorySlackInstallationBus } from "../src/surfaces/slack-installation-events.ts";

type StoredMap = Parameters<typeof createSlackInstallationStore>[1];
type Stored = NonNullable<Awaited<ReturnType<StoredMap["get"]>>>;

function instrumentedMap(trace: string[] = []): { map: DurableMap<Stored>; gets: () => number; trace: string[] } {
  const inner = createMemoryMap<Stored>();
  let gets = 0;
  return {
    map: {
      ...inner,
      get: async (id) => {
        gets += 1;
        return inner.get(id);
      },
      put: async (id, value) => {
        await inner.put(id, value);
        trace.push("put");
      },
    },
    gets: () => gets,
    trace,
  };
}

const credentials = { botToken: "xoxb-live", appToken: "xapp-live", updatedBy: "admin@acme" };

test("state() resolves unmanaged, active, and disabled from a single read", async () => {
  const backing = instrumentedMap();
  const store = createSlackInstallationStore("org", backing.map, "key-material", createMemorySlackInstallationBus());

  assert.deepEqual(await store.state(), { managed: false, installation: null });
  assert.equal(backing.gets(), 1, "one read per state() snapshot");

  const saved = await store.set({ ...credentials, teamId: "T1" });
  const active = await store.state();
  assert.equal(active.managed, true);
  assert.deepEqual(
    { botToken: active.installation?.botToken, appToken: active.installation?.appToken },
    { botToken: "xoxb-live", appToken: "xapp-live" },
  );
  assert.equal(active.installation?.version, saved.version);
  assert.equal(backing.gets(), 2);

  await store.delete("admin@acme");
  assert.deepEqual(
    await store.state(),
    { managed: true, installation: null },
    "an uninstalled record stays managed so the environment fallback cannot resurrect it",
  );
  assert.equal(backing.gets(), 3);
});

test("set and delete publish the new version after the write, carrying no token material", async () => {
  const trace: string[] = [];
  const backing = instrumentedMap(trace);
  const bus = createMemorySlackInstallationBus();
  const published: unknown[] = [];
  bus.subscribe((event) => {
    trace.push("emit");
    published.push(event);
  });
  const store = createSlackInstallationStore("org", backing.map, "key-material", bus);

  const saved = await store.set(credentials);
  await store.delete("admin@acme");

  assert.deepEqual(trace, ["put", "emit", "put", "emit"], "each write publishes once, after the row lands");
  assert.deepEqual(published[0], { version: saved.version }, "the notify payload never carries token material");
  const removal = published[1] as Record<string, unknown>;
  assert.deepEqual(Object.keys(removal), ["version"]);
  assert.notEqual(removal.version, saved.version);
});
