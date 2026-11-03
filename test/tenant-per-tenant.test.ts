import assert from "node:assert/strict";
import test from "node:test";
import { perTenant, withTenant, withoutTenant } from "../src/tenants/context.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("perTenant keeps one value per bound tenant", async () => {
  const cache = perTenant(() => new Map<string, string>());
  await withTenant(A, () => cache().set("k", "a"));
  await withTenant(B, () => cache().set("k", "b"));
  assert.equal(await withTenant(A, () => cache().get("k")), "a");
  assert.equal(await withTenant(B, () => cache().get("k")), "b");
  await withTenant(A, () => cache().clear());
  assert.equal(await withTenant(B, () => cache().get("k")), "b");
});

test("perTenant fails closed when no tenant is bound", () => {
  const cache = perTenant(() => new Map<string, string>());
  assert.throws(() => withoutTenant(() => cache()), /No tenant is bound/);
});
