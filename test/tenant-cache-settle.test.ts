import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { perTenant, withTenant } from "../src/tenants/context.ts";
import { refreshTenants, workTenant } from "../src/tenants/work-tenant.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";

test("only the process's tenant watch moves unbound caches from the unsettled slot to the sole tenant's own", async (t) => {
  const pool = createPgPool(testMigratedDatabaseUrl());
  t.after(() => pool.close());
  const slot = perTenant<{ seen: string[] }>(() => ({ seen: [] }));
  slot().seen.push("cached while unsettled");
  const sole = await workTenant(pool);
  assert.deepEqual(slot().seen, ["cached while unsettled"]);
  await refreshTenants(pool, true);
  assert.deepEqual(slot().seen, []);
  slot().seen.push("cached once settled");
  assert.deepEqual(
    withTenant(sole, () => slot().seen),
    ["cached once settled"],
  );
});
