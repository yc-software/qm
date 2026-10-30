import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { ownerRowTenants } from "../src/tenants/row-tenant.ts";
import { OTHER_TENANT, TEST_TENANT } from "./support/tenant.ts";

const url = process.env.DATABASE_URL;

test("the owner row lookup finds a row's tenant across tenants by its id", { skip: !url }, async () => {
  const db = createPgPool(url!);
  const table = `row_tenant_fixture_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.q(
      `CREATE TABLE ${table} (tenant_id uuid NOT NULL, id text NOT NULL, name text, PRIMARY KEY (tenant_id, id))`,
    );
    await db.q(
      `INSERT INTO ${table} VALUES ($1, 'a-only', 'app-a'), ($2, 'b-only', 'app-b'), ($1, 'shared', NULL), ($2, 'shared', NULL)`,
      [TEST_TENANT, OTHER_TENANT],
    );
    const lookup = ownerRowTenants(db);
    assert.deepEqual(await lookup(table, ["id"], "a-only"), [TEST_TENANT]);
    assert.deepEqual(await lookup(table, ["id"], "b-only"), [OTHER_TENANT]);
    assert.deepEqual(await lookup(table, ["id"], "missing"), []);
    assert.deepEqual((await lookup(table, ["id"], "shared")).sort(), [TEST_TENANT, OTHER_TENANT].sort());
    assert.deepEqual(await lookup(table, ["name", "id"], "app-b"), [OTHER_TENANT]);
    await assert.rejects(() => lookup(`${table}; DROP TABLE x`, ["id"], "a-only"), /Invalid row reference/);
    await assert.rejects(() => lookup(table, ["id = id OR true"], "a-only"), /Invalid row reference/);
  } finally {
    await db.q(`DROP TABLE IF EXISTS ${table}`);
    await db.close();
  }
});
