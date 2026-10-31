import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConfigTables } from "../src/resolution/config-tables.ts";
import { scopeId } from "../src/types.ts";
import { testConfigStore, testConfigTables } from "./support/test-database.ts";

const channel = scopeId("channel", "C1");

function withUpdate(tables: ConfigTables, update: ConfigTables["updateScopeSetting"]): ConfigTables {
  return { ...tables, updateScopeSetting: update };
}

test("a config write resolves only after another instance can read it from the store", async () => {
  const tables = testConfigTables();
  const slow = withUpdate(tables, async (id, fn) => {
    await sleep(20);
    return tables.updateScopeSetting(id, fn);
  });
  const writer = testConfigStore("default-org", { tables: slow });
  const reader = testConfigStore("default-org", { tables });

  await writer.setOrgAmbient(false);

  assert.equal(await reader.getOrgAmbientDurable(), false);
});

test("a failed config write rejects and leaves this instance's cache on the stored value", async () => {
  const tables = testConfigTables();
  const failing = withUpdate(tables, async () => {
    throw new Error("database unavailable");
  });
  const config = testConfigStore("default-org", { tables: failing });

  await assert.rejects(config.setEgress(channel, { allowedHosts: ["api.example.com"] }), /database unavailable/);

  assert.equal(config.getEgress(channel), null);
  assert.equal(await tables.scopeSetting(channel), null);
});
