import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryConfigStore,
  type FactoryConfig,
  type PersistedDeploymentIdentity,
  type PersistedFactoryConfig,
  type PersistedInternalMemberOverrides,
} from "../src/resolution/config-store.ts";

test("a durable database is pinned to one organization", async () => {
  const deploymentIdentity = createMemoryMap<PersistedDeploymentIdentity>();
  await createMemoryConfigStore("default-org", { deploymentIdentity }).hydrate!();
  await assert.rejects(
    createMemoryConfigStore("other", { deploymentIdentity }).hydrate!(),
    /database belongs to org default-org/,
  );
});

test("internal member overrides normalize, persist org-wide, and hydrate back", async () => {
  const internalMemberOverrides = createMemoryMap<PersistedInternalMemberOverrides>();
  const store = createMemoryConfigStore("default-org", { internalMemberOverrides });
  await store.hydrate!();
  assert.deepEqual(store.getInternalMemberOverrides(), []);
  store.setInternalMemberOverrides(["  Contractor@EXAMPLE.com ", "U123ABC", "contractor@example.com", ""]);
  assert.deepEqual(store.getInternalMemberOverrides(), ["contractor@example.com", "u123abc"]);
  await store.flushScope("org:default-org");
  assert.deepEqual(await store.getInternalMemberOverridesDurable(), ["contractor@example.com", "u123abc"]);
  const rehydrated = createMemoryConfigStore("default-org", { internalMemberOverrides });
  await rehydrated.hydrate!();
  assert.deepEqual(rehydrated.getInternalMemberOverrides(), ["contractor@example.com", "u123abc"]);
});

const slowWritingMap = (): DurableMap<PersistedFactoryConfig> => {
  const inner = createMemoryMap<PersistedFactoryConfig>();
  const afterTimer = async <T>(op: () => Promise<T>): Promise<T> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return op();
  };
  return {
    ...inner,
    put: (id, value) => afterTimer(() => inner.put(id, value)),
    delete: (id) => afterTimer(() => inner.delete(id)),
  };
};

const FACTORY_CONFIG: FactoryConfig = {
  forge: "github",
  publishProject: "yc-software/qm",
  targetBranch: "main",
  repoCloneUrl: "https://github.com/yc-software/qm.git",
  linearTeamId: "QM",
  sourceAppDirs: "src,plugins",
  sourceTestRe: "^test/.*\\.test\\.ts$",
  verifyTestsCmd: "npm test",
  verifyTestFileCmd: "node --test",
  verifyLintCmd: "npm run lint",
  bugbotRequired: true,
  followupsEnabled: false,
};

test("the factory config persists org-wide, hydrates back without its scope id, and clears", async () => {
  const factoryConfigs = slowWritingMap();
  const store = createMemoryConfigStore("default-org", { factoryConfigs });
  await store.hydrate!();
  assert.equal(store.getFactoryConfig(), null);

  store.setFactoryConfig(FACTORY_CONFIG);
  assert.deepEqual(store.getFactoryConfig(), FACTORY_CONFIG);
  await store.flushScope("org:default-org");

  const rebuilt = createMemoryConfigStore("default-org", { factoryConfigs });
  await rebuilt.hydrate!();
  assert.deepEqual(rebuilt.getFactoryConfig(), FACTORY_CONFIG);
  assert.equal(Object.hasOwn(rebuilt.getFactoryConfig()!, "scopeId"), false);

  store.setFactoryConfig(null);
  assert.equal(store.getFactoryConfig(), null);
  await store.flushScope("org:default-org");
  assert.equal(await factoryConfigs.get("org:default-org"), null);

  const afterClear = createMemoryConfigStore("default-org", { factoryConfigs });
  await afterClear.hydrate!();
  assert.equal(afterClear.getFactoryConfig(), null);
});

test("a second instance sees factory config writes and deletes after refreshing the org scope", async () => {
  const factoryConfigs = slowWritingMap();
  const a = createMemoryConfigStore("default-org", { factoryConfigs });
  const b = createMemoryConfigStore("default-org", { factoryConfigs });
  await a.hydrate!();
  await b.hydrate!();

  a.setFactoryConfig(FACTORY_CONFIG);
  await a.flushScope("org:default-org");
  assert.equal(b.getFactoryConfig(), null);
  await b.refreshScope("org:default-org");
  assert.deepEqual(b.getFactoryConfig(), FACTORY_CONFIG);

  await b.refreshScope("channel:C1");
  assert.deepEqual(b.getFactoryConfig(), FACTORY_CONFIG);

  a.setFactoryConfig(null);
  await a.flushScope("org:default-org");
  await b.refreshScope("org:default-org");
  assert.equal(b.getFactoryConfig(), null);
});

test("the factory config is copied on set and on get, so neither caller can mutate the stored record", async () => {
  const factoryConfigs = slowWritingMap();
  const store = createMemoryConfigStore("default-org", { factoryConfigs });
  await store.hydrate!();

  const caller = { ...FACTORY_CONFIG };
  store.setFactoryConfig(caller);
  caller.targetBranch = "hacked";
  assert.equal(store.getFactoryConfig()!.targetBranch, "main");

  const read = store.getFactoryConfig()!;
  read.targetBranch = "hacked-too";
  assert.equal(store.getFactoryConfig()!.targetBranch, "main");

  await store.flushScope("org:default-org");
  const rebuilt = createMemoryConfigStore("default-org", { factoryConfigs });
  await rebuilt.hydrate!();
  assert.deepEqual(rebuilt.getFactoryConfig(), FACTORY_CONFIG);
});

test("the factory config is bound to a durable map in wiring, not to per-instance memory", async () => {
  const wiring = await readFile(new URL("../src/wiring.ts", import.meta.url), "utf8");
  assert.match(wiring, /factoryConfigs: artifactMap<\w+>\("factory_configs"\)/);
});
