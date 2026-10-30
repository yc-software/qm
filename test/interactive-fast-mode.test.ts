import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { scopeId } from "../src/types.ts";
import { resolveTurnFastMode } from "../src/core/turn-options.ts";
import { createMemoryConfigTables } from "../src/resolution/config-tables.ts";
import { bindTestTenant } from "./support/tenant.ts";

bindTestTenant();

test("interactive fast mode defaults off and persists across instances", async () => {
  const tables = createMemoryConfigTables();
  const first = createMemoryConfigStore("org", { tables });
  await first.hydrate!();
  assert.equal(first.getInteractiveFastMode(), false);
  assert.equal(await first.getInteractiveFastModeDurable(), false);

  await first.setInteractiveFastMode(true);
  assert.equal(first.getInteractiveFastMode(), true);

  const second = createMemoryConfigStore("org", { tables });
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
  const tables = createMemoryConfigTables();
  const store = createMemoryConfigStore("org", { tables });
  await store.hydrate!();
  const org = scopeId("org", "org");
  await tables.updateScopeSetting(org, (row) => ({ ...row, interactiveFastMode: true }));
  await store.refreshScope(org);
  assert.equal(store.getInteractiveFastMode(), true);
});
