import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { scopeId, type ScopeId } from "../src/types.ts";

const channel = scopeId("channel", "C1");

function withPut<T>(map: DurableMap<T>, put: DurableMap<T>["put"]): DurableMap<T> {
  return new Proxy(map, { get: (target, key) => (key === "put" ? put : Reflect.get(target, key)) });
}

test("a config write resolves only after another instance can read it from the store", async () => {
  const orgAmbient = createMemoryMap<{ scopeId: ScopeId; on: boolean }>();
  const slow = withPut(orgAmbient, async (key, value) => {
    await sleep(20);
    return orgAmbient.put(key, value);
  });
  const writer = createMemoryConfigStore("default-org", { orgAmbient: slow });
  const reader = createMemoryConfigStore("default-org", { orgAmbient });

  await writer.setOrgAmbient(false);

  assert.equal(await reader.getOrgAmbientDurable(), false);
});

test("a failed config write rejects and leaves this instance's cache on the stored value", async () => {
  const egressPolicies = createMemoryMap<{ scopeId: ScopeId; policy: { allowedHosts: string[] } }>();
  const failing = withPut(egressPolicies, async () => {
    throw new Error("database unavailable");
  });
  const config = createMemoryConfigStore("default-org", { egressPolicies: failing });

  await assert.rejects(config.setEgress(channel, { allowedHosts: ["api.example.com"] }), /database unavailable/);

  assert.equal(config.getEgress(channel), null);
  assert.equal(await egressPolicies.get(channel), null);
});
