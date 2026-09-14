import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryConfigStore, type PersistedModelClassification } from "../src/resolution/config-store.ts";
import { derivedStatus, effectiveStatus, isHiddenStatus } from "../src/model/model-classification.ts";
import { builtinRegistryEntry } from "../src/model/pi-models.ts";
import { scopeId } from "../src/types.ts";

const org = scopeId("org", "default-org");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("model classifications default empty and store only real overrides", async () => {
  const backing = createMemoryMap<PersistedModelClassification>();
  const store = createMemoryConfigStore("default-org", { modelClassifications: backing });
  await store.hydrate!();

  assert.deepEqual(store.getModelClassifications(org), {});
  assert.deepEqual(await store.getModelClassificationsDurable(org), {});

  store.setModelClassification(org, "claude-opus-5", "legacy");
  await settle();
  assert.deepEqual(store.getModelClassifications(org), { "claude-opus-5": "legacy" });
  assert.deepEqual(await store.getModelClassificationsDurable(org), { "claude-opus-5": "legacy" });

  store.setModelClassification(org, "claude-sonnet-5", "hidden");
  await settle();
  assert.deepEqual(store.getModelClassifications(org), { "claude-opus-5": "legacy", "claude-sonnet-5": "hidden" });

  store.setModelClassification(org, "claude-opus-5", "active");
  await settle();
  assert.deepEqual(store.getModelClassifications(org), { "claude-sonnet-5": "hidden" });

  store.setModelClassification(org, "claude-sonnet-5", "active");
  await settle();
  assert.deepEqual(store.getModelClassifications(org), {});
  assert.deepEqual(await backing.all(), []);
});

test("model classifications survive a second app instance on the same durable store", async () => {
  const backing = createMemoryMap<PersistedModelClassification>();
  const first = createMemoryConfigStore("default-org", { modelClassifications: backing });
  await first.hydrate!();
  first.setModelClassification(org, "claude-opus-5", "legacy");
  await settle();

  const second = createMemoryConfigStore("default-org", { modelClassifications: backing });
  await second.hydrate!();
  assert.deepEqual(second.getModelClassifications(org), { "claude-opus-5": "legacy" });
  assert.deepEqual(await second.getModelClassificationsDurable(org), { "claude-opus-5": "legacy" });
});

test("derived status hides the base-and-webui-off registry entries and nothing else", () => {
  assert.equal(derivedStatus(builtinRegistryEntry("claude-opus-4-7")), "hidden");
  assert.equal(derivedStatus(builtinRegistryEntry("claude-opus-4-6")), "hidden");
  assert.equal(derivedStatus(builtinRegistryEntry("claude-opus-5")), "active");
  assert.equal(derivedStatus(builtinRegistryEntry("gpt-5.6-sol")), "active");
  assert.equal(derivedStatus(undefined), "active");

  assert.equal(isHiddenStatus("hidden"), true);
  assert.equal(isHiddenStatus("deprecated"), true);
  assert.equal(isHiddenStatus("legacy"), false);
  assert.equal(isHiddenStatus("active"), false);
  assert.equal(isHiddenStatus(undefined), false);

  assert.equal(effectiveStatus("claude-opus-4-7", {}), "hidden");
  assert.equal(effectiveStatus("claude-opus-4-7", { "claude-opus-4-7": "active" }), "active");
  assert.equal(effectiveStatus("claude-opus-5", { "claude-opus-5": "deprecated" }), "deprecated");
});
