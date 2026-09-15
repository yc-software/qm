import assert from "node:assert/strict";
import { test } from "node:test";
import { createCustomProviderStore, type StoredCustomProvider } from "../src/model/custom-provider-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { customProviderConfiguredForHarness, readyCustomProviderIds } from "../src/model/custom-provider-readiness.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const NOW = Date.now();

test.afterEach(() => setCustomProviders([]));

test("readiness is false with no store, absent, disabled, or keyless providers", async () => {
  assert.equal(await customProviderConfiguredForHarness(undefined, "pi"), false);

  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "unit-test-key-material" });
  await store.upsert(
    {
      id: "keyless",
      name: "Keyless",
      protocol: "openai",
      baseUrl: "https://llm.example.test/v1",
      models: [{ id: "keyless-model", name: "Keyless" }],
    },
    undefined,
    "tester",
  );
  setCustomProviders(await store.enabled());
  assert.equal(await customProviderConfiguredForHarness(store, "pi"), false);

  await store.upsert(
    {
      id: "acme",
      name: "Acme",
      protocol: "openai",
      baseUrl: "https://llm.acme.internal/v1",
      models: [{ id: "acme-large", name: "Acme Large" }],
    },
    "sk-acme-secret",
    "tester",
  );
  setCustomProviders(await store.enabled());
  await store.delete("acme", "tester");
  setCustomProviders(await store.enabled());
  assert.equal(await customProviderConfiguredForHarness(store, "pi"), false);
});

test("a keyed, enabled provider with zero models is not ready (defensive against corrupt/legacy rows)", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  await backing.put("zero-model", {
    id: "zero-model",
    name: "Zero Model",
    protocol: "openai",
    baseUrl: "https://llm.example.test/v1",
    models: [],
    apiKeyEnc: "v2:aa:bb:cc",
    disabled: false,
    updatedAt: NOW,
    updatedBy: "tester",
  });
  const store = createCustomProviderStore({ backing, keyMaterial: "unit-test-key-material" });
  setCustomProviders(await store.enabled());
  assert.equal(await customProviderConfiguredForHarness(store, "pi"), false);
  assert.equal((await readyCustomProviderIds(store, "pi")).size, 0);
});

test("a stored key that fails to decrypt (corrupt ciphertext or rotated key material) is not ready, and does not throw", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const writingStore = createCustomProviderStore({ backing, keyMaterial: "material-a" });
  await writingStore.upsert(
    {
      id: "acme",
      name: "Acme",
      protocol: "openai",
      baseUrl: "https://llm.acme.internal/v1",
      models: [{ id: "acme-large", name: "Acme Large" }],
    },
    "sk-acme-secret",
    "tester",
  );
  const readingStore = createCustomProviderStore({ backing, keyMaterial: "material-b-completely-different" });
  setCustomProviders(await readingStore.enabled());

  await assert.rejects(() => readingStore.resolveKey("acme"));

  await assert.doesNotReject(() => customProviderConfiguredForHarness(readingStore, "pi"));
  assert.equal(await customProviderConfiguredForHarness(readingStore, "pi"), false);
  assert.equal((await readyCustomProviderIds(readingStore, "pi")).size, 0);

  assert.equal(await customProviderConfiguredForHarness(writingStore, "pi"), true);
});

test("readiness follows harness support: pi and opencode yes, codex and claude no, for the same custom model", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "unit-test-key-material" });
  await store.upsert(
    {
      id: "acme",
      name: "Acme",
      protocol: "openai",
      baseUrl: "https://llm.acme.internal/v1",
      models: [{ id: "acme-large", name: "Acme Large" }],
    },
    "sk-acme-secret",
    "tester",
  );
  setCustomProviders(await store.enabled());

  assert.equal(await customProviderConfiguredForHarness(store, "pi"), true);
  assert.equal(await customProviderConfiguredForHarness(store, "opencode"), true);
  assert.equal(await customProviderConfiguredForHarness(store, "codex"), false);
  assert.equal(await customProviderConfiguredForHarness(store, "claude"), false);
});
