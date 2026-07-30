import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore, type PersistedScopedFlag } from "../src/resolution/config-store.ts";
import { scopeId } from "../src/types.ts";

test("interactive fast mode defaults off and persists across instances", async () => {
  const interactiveFastMode = createMemoryMap<PersistedScopedFlag>();
  const first = createMemoryConfigStore("org", { interactiveFastMode });
  await first.hydrate!();
  assert.equal(first.getInteractiveFastMode(), false);
  assert.equal(await first.getInteractiveFastModeDurable(), false);

  first.setInteractiveFastMode(true);
  assert.equal(first.getInteractiveFastMode(), true);
  await first.flushScope(scopeId("org", "org"));

  const second = createMemoryConfigStore("org", { interactiveFastMode });
  await second.hydrate!();
  assert.equal(second.getInteractiveFastMode(), true);
  assert.equal(await second.getInteractiveFastModeDurable(), true);
});

test("refreshScope picks up an interactive fast mode change written elsewhere", async () => {
  const interactiveFastMode = createMemoryMap<PersistedScopedFlag>();
  const store = createMemoryConfigStore("org", { interactiveFastMode });
  await store.hydrate!();
  const org = scopeId("org", "org");
  await interactiveFastMode.put(org, { scopeId: org, on: true });
  await store.refreshScope(org);
  assert.equal(store.getInteractiveFastMode(), true);
});
