import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadTenant } from "../src/tenants/cache.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

const skills = [
  {
    path: "skills/acme/SKILL.md",
    content: "---\nname: acme\ndescription: Use Acme systems.\n---\nRun the acme tool.\n",
  },
];

test("each tenant gets the stored deployment layer's skills when it first loads", async () => {
  const databaseUrl = testMigratedDatabaseUrl();
  const owner = new pg.Pool({ connectionString: ownerUrl(databaseUrl).toString() });
  const other = randomUUID();
  await owner.query("INSERT INTO tenants(id) VALUES ($1)", [other]);
  const built = buildApp(testConfig({ databaseUrl }));
  const org = [scopeId("org", "default-org")];
  try {
    await withTenant(TEST_TENANT, () => built.deploymentLayerStore.put({ contract: 1, tools: [], skills }, "test"));
    assert.equal((await withTenant(other, () => built.skills.resolve("acme", org))).skill, null);
    await withTenant(other, () => loadTenant());
    assert.equal((await withTenant(other, () => built.skills.resolve("acme", org))).skill?.status, "published");
  } finally {
    await built.runtime.stop();
    await owner.end();
  }
});
