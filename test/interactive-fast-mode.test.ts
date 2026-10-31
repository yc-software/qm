import { test } from "node:test";
import assert from "node:assert/strict";
import { type PersistedScopedFlag } from "../src/resolution/config-store.ts";
import { scopeId } from "../src/types.ts";
import { resolveTurnFastMode } from "../src/core/turn-options.ts";
import { testConfigStore, testMap } from "./support/test-database.ts";
import { TEST_ROOT_SCOPE } from "./support/tenant.ts";

test("interactive fast mode defaults off and persists across instances", async () => {
  const interactiveFastMode = testMap<PersistedScopedFlag>();
  const first = testConfigStore({ interactiveFastMode });
  await first.hydrate!();
  assert.equal(first.getInteractiveFastMode(), false);
  assert.equal(await first.getInteractiveFastModeDurable(), false);

  await first.setInteractiveFastMode(true);
  assert.equal(first.getInteractiveFastMode(), true);

  const second = testConfigStore({ interactiveFastMode });
  await second.hydrate!();
  assert.equal(second.getInteractiveFastMode(), true);
  assert.equal(await second.getInteractiveFastModeDurable(), true);
});

test("the org default reaches only human turns that expressed no preference", () => {
  assert.equal(resolveTurnFastMode(undefined, true, true), true);
  assert.equal(resolveTurnFastMode(undefined, true, false), undefined);
  assert.equal(resolveTurnFastMode(undefined, false, true), undefined);
  assert.equal(resolveTurnFastMode(false, true, true), false);
  assert.equal(resolveTurnFastMode(true, false, false), true);
});

test("refreshScope picks up an interactive fast mode change written elsewhere", async () => {
  const interactiveFastMode = testMap<PersistedScopedFlag>();
  const store = testConfigStore({ interactiveFastMode });
  await store.hydrate!();
  const org = TEST_ROOT_SCOPE;
  await interactiveFastMode.put(org, { scopeId: org, on: true });
  await store.refreshScope(org);
  assert.equal(store.getInteractiveFastMode(), true);
});
