import { test } from "node:test";
import assert from "node:assert/strict";
import { withTenant } from "../src/tenants/context.ts";
import { sortedRows, tenantRows } from "../src/tenants/memory-rows.ts";

test("tenant rows keep one map per bound tenant and refuse unbound access", () => {
  const rows = tenantRows<string>();
  withTenant("00000000-0000-4000-8000-00000000000a", () => rows().set("b", "a-b").set("a", "a-a"));
  withTenant("00000000-0000-4000-8000-00000000000b", () => rows().set("a", "b-a"));
  assert.deepEqual(
    withTenant("00000000-0000-4000-8000-00000000000a", () => sortedRows(rows())),
    ["a-a", "a-b"],
  );
  assert.deepEqual(
    withTenant("00000000-0000-4000-8000-00000000000b", () => sortedRows(rows())),
    ["b-a"],
  );
  assert.throws(() => rows(), /No tenant is bound/);
});
