import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeConfig } from "../src/core-bridge.ts";
import {
  RuntimeConfigCache,
  RUNTIME_CONFIG_CACHE_TTL_MS,
  runtimeConfigCache,
  updateCachedRuntimeConfig,
} from "../src/runtime-config-cache.ts";
import { effectiveScopeId, personalScopeIdFor } from "../src/scope-id.ts";

function config(scopeId: string, modelId: string): RuntimeConfig {
  return {
    scopeId,
    approvedHarnesses: ["pi"],
    modelsByHarness: { pi: [modelId] },
    modelCatalog: { [modelId]: { name: modelId, provider: "fixture" } },
    orgDefault: { harnessId: "pi", modelId, revision: 1 },
    scopeOverride: null,
    effective: { harnessId: "pi", modelId },
    upgradeAvailable: false,
  };
}

test("runtime config cache retains independent scopes until their TTL expires", () => {
  let now = 1_000;
  const cache = new RuntimeConfigCache(() => now);
  const personal = config("personal:fixture-alpha", "personal-model");
  const project = config("project:fixture", "project-model");

  cache.set(personal.scopeId, personal);
  now += 10_000;
  cache.set(project.scopeId, project);

  assert.equal(cache.get(project.scopeId), project);
  assert.equal(cache.get(personal.scopeId), personal);

  now = 1_000 + RUNTIME_CONFIG_CACHE_TTL_MS;
  assert.equal(cache.get(personal.scopeId), null);
  assert.equal(cache.get(project.scopeId), project);
});

test("runtime config cache updates and invalidates only the selected scope", () => {
  const cache = new RuntimeConfigCache(() => 1_000);
  const personal = config("personal:fixture-alpha", "old-model");
  const updated = config("personal:fixture-alpha", "new-model");
  const project = config("project:fixture", "project-model");

  cache.set(personal.scopeId, personal);
  cache.set(project.scopeId, project);
  cache.set(updated.scopeId, updated);
  cache.invalidate(project.scopeId);

  assert.equal(cache.get(personal.scopeId), updated);
  assert.equal(cache.get(project.scopeId), null);
});

test("a completed mutation wins over an older fetch, including a failed fetch", () => {
  const cache = new RuntimeConfigCache(() => 1_000);
  const scopeId = "project:mutation-wins";
  const stale = config(scopeId, "stale-model");
  const updated = config(scopeId, "updated-model");
  const revision = cache.revision(scopeId);

  cache.set(scopeId, updated);

  assert.equal(cache.resolveFetch(scopeId, revision, stale), updated);
  assert.equal(cache.resolveFetch(scopeId, revision, null), updated);
});

test("runtime config mutations serialize per scope and recover after rejection", async () => {
  const scopeId = "project:serialized-mutations";
  const firstConfig = config(scopeId, "first-model");
  const secondConfig = config(scopeId, "second-model");
  let releaseFirst = (): void => {};
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];

  const first = updateCachedRuntimeConfig(scopeId, async () => {
    order.push("first");
    markStarted();
    await firstGate;
    return firstConfig;
  });
  await started;
  const second = updateCachedRuntimeConfig(scopeId, async () => {
    order.push("second");
    return secondConfig;
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first"]);
  releaseFirst();
  assert.equal(await first, firstConfig);
  assert.equal(await second, secondConfig);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(runtimeConfigCache.get(scopeId), secondConfig);

  const recoveryScope = "project:rejected-mutation";
  const rejected = updateCachedRuntimeConfig(recoveryScope, async () => {
    throw new Error("fixture rejection");
  });
  const recovered = updateCachedRuntimeConfig(recoveryScope, async () => config(recoveryScope, "recovered-model"));
  await assert.rejects(rejected, /fixture rejection/);
  assert.equal((await recovered).effective.modelId, "recovered-model");
});

test("scope IDs have one personal fallback and preserve explicit scopes", () => {
  assert.equal(personalScopeIdFor("fixture-alpha@example.test"), "personal:fixture-alpha@example.test");
  assert.equal(personalScopeIdFor(null), null);
  assert.equal(effectiveScopeId("channel:C1", "fixture-alpha@example.test"), "channel:C1");
  assert.equal(effectiveScopeId(null, "fixture-alpha@example.test"), "personal:fixture-alpha@example.test");
  assert.equal(effectiveScopeId(null, undefined), null);
});
