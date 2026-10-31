import assert from "node:assert/strict";
import test from "node:test";
import { onFirstBind, perTenant, tenantReady, withTenant, withoutTenant } from "../src/tenants/context.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

test("perTenant keeps one value per bound tenant", () => {
  const cache = perTenant(() => new Map<string, string>());
  withTenant(A, () => cache().set("k", "a"));
  withTenant(B, () => cache().set("k", "b"));
  assert.equal(
    withTenant(A, () => cache().get("k")),
    "a",
  );
  assert.equal(
    withTenant(B, () => cache().get("k")),
    "b",
  );
  withTenant(A, () => cache().clear());
  assert.equal(
    withTenant(B, () => cache().get("k")),
    "b",
  );
});

test("perTenant fails closed when no tenant is bound", () => {
  const cache = perTenant(() => new Map<string, string>());
  assert.throws(() => withoutTenant(() => cache()), /No tenant is bound/);
});

test("tenantReady runs every hook the bound tenant has not finished, including hooks registered after its first bind", async () => {
  const C = "00000000-0000-4000-8000-00000000000c";
  const runs: string[] = [];
  const stopFirst = onFirstBind(async (tenant) => void runs.push(`first:${tenant}`));
  await withTenant(C, () => tenantReady());
  let failures = 1;
  const stopLate = onFirstBind(async (tenant) => {
    if (failures-- > 0) throw new Error("load failed");
    runs.push(`late:${tenant}`);
  });
  try {
    await assert.rejects(
      withTenant(C, () => tenantReady()),
      /load failed/,
    );
    await withTenant(C, () => tenantReady());
    await withTenant(C, () => tenantReady());
    assert.deepEqual(runs, [`first:${C}`, `late:${C}`]);
  } finally {
    stopFirst();
    stopLate();
  }
});
