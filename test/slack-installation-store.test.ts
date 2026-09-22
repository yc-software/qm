import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { createMemorySlackInstallationBus } from "../src/surfaces/slack-installation-events.ts";

type Stored = NonNullable<Awaited<ReturnType<Parameters<typeof createSlackInstallationStore>[1]["get"]>>>;

function tracingMap(trace: string[]): DurableMap<Stored> {
  const inner = createMemoryMap<Stored>();
  return {
    ...inner,
    get: async (id) => {
      trace.push("get");
      return inner.get(id);
    },
    put: async (id, value) => {
      await inner.put(id, value);
      trace.push("put");
    },
  };
}

const credentials = { botToken: "xoxb-live", appToken: "xapp-live", updatedBy: "admin@acme" };

test("catches state() reading twice or calling a disabled record unmanaged", async () => {
  const trace: string[] = [];
  const store = createSlackInstallationStore(
    "org",
    tracingMap(trace),
    "key-material",
    createMemorySlackInstallationBus(),
  );

  assert.deepEqual(await store.state(), { managed: false, installation: null });

  const saved = await store.set({ ...credentials, teamId: "T1" });
  const active = await store.state();
  assert.deepEqual(
    {
      managed: active.managed,
      botToken: active.installation?.botToken,
      appToken: active.installation?.appToken,
      version: active.installation?.version,
    },
    { managed: true, botToken: "xoxb-live", appToken: "xapp-live", version: saved.version },
  );

  await store.delete("admin@acme");
  assert.deepEqual(
    await store.state(),
    { managed: true, installation: null },
    "an uninstalled record stays managed so the environment fallback cannot resurrect it",
  );
  assert.equal(trace.filter((step) => step === "get").length, 3, "one read per state() snapshot");
});

test("catches a write publishing before the row lands, skipping the uninstall, or carrying tokens", async () => {
  const trace: string[] = [];
  const bus = createMemorySlackInstallationBus();
  const published: unknown[] = [];
  bus.subscribe((event) => {
    trace.push("emit");
    published.push(event);
  });
  const store = createSlackInstallationStore("org", tracingMap(trace), "key-material", bus);

  const saved = await store.set(credentials);
  await store.delete("admin@acme");

  assert.deepEqual(trace, ["put", "emit", "put", "emit"], "each write publishes once, after the row lands");
  assert.deepEqual(published[0], { version: saved.version }, "the notify payload never carries token material");
  assert.deepEqual(Object.keys(published[1] as object), ["version"]);
  assert.notEqual((published[1] as { version: string }).version, saved.version);
});
