import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { scopeId } from "../src/types.ts";
import { bindTestTenant } from "./support/tenant.ts";
import { createMemoryConfigTables, type ConfigTables } from "../src/resolution/config-tables.ts";

bindTestTenant();

const channel = scopeId("channel", "C1");

function withUpdate(tables: ConfigTables, update: ConfigTables["updateScopeSetting"]): ConfigTables {
  return { ...tables, updateScopeSetting: update };
}

test("a config write resolves only after another instance can read it from the store", async () => {
  const tables = createMemoryConfigTables();
  const slow = withUpdate(tables, async (id, fn) => {
    await sleep(20);
    return tables.updateScopeSetting(id, fn);
  });
  const writer = createMemoryConfigStore({ tables: slow });
  const reader = createMemoryConfigStore({ tables });

  await writer.setOrgAmbient(false);

  assert.equal(await reader.getOrgAmbientDurable(), false);
});

test("a failed config write rejects and leaves this instance's cache on the stored value", async () => {
  const tables = createMemoryConfigTables();
  const failing = withUpdate(tables, async () => {
    throw new Error("database unavailable");
  });
  const config = createMemoryConfigStore({ tables: failing });

  await assert.rejects(config.setEgress(channel, { allowedHosts: ["api.example.com"] }), /database unavailable/);

  assert.equal(config.getEgress(channel), null);
  assert.equal(await tables.scopeSetting(channel), null);
});
