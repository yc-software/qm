import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { tenant, tenantFor, withTenant } from "../src/tenant.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createFeatureFlagStore, type FeatureFlagRecord } from "../src/feature-flags.ts";
import { createAdminService } from "../src/admin/admin-service.ts";

test("outside any tenant context the process tenant comes from ORG_ID", () => {
  const before = process.env.ORG_ID;
  try {
    process.env.ORG_ID = "acme";
    assert.deepEqual(tenant(), { orgId: "acme", orgScope: "org:acme" });
    delete process.env.ORG_ID;
    assert.deepEqual(tenant(), { orgId: "default-org", orgScope: "org:default-org" });
  } finally {
    if (before === undefined) delete process.env.ORG_ID;
    else process.env.ORG_ID = before;
  }
});

test("a tenant context follows async work and does not leak into concurrent work", async () => {
  const seen: string[] = [];
  const work = (orgId: string, wait: number) =>
    withTenant(tenantFor(orgId), async () => {
      await delay(wait);
      seen.push(`${orgId}:${tenant().orgId}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      seen.push(`${orgId}:${tenant().orgScope}`);
    });
  await Promise.all([work("alpha", 5), work("beta", 1)]);
  assert.deepEqual(seen.sort(), ["alpha:alpha", "alpha:org:alpha", "beta:beta", "beta:org:beta"]);
  assert.equal(tenant().orgId, process.env.ORG_ID ?? "default-org");
});

test("one feature flag store serves each tenant its own org-wide switch", async () => {
  const store = createFeatureFlagStore(createMemoryMap<FeatureFlagRecord>());
  await withTenant(tenantFor("alpha"), () => store.setEnabled("inbox_loops", "org:alpha", true, "admin"));
  assert.equal(await withTenant(tenantFor("alpha"), () => store.enabled("inbox_loops", "channel:C1")), true);
  assert.equal(await withTenant(tenantFor("beta"), () => store.enabled("inbox_loops", "channel:C1")), false);
});

test("one admin service resolves internal actors only for the tenant in context", () => {
  const admin = createAdminService();
  assert.deepEqual(
    withTenant(tenantFor("alpha"), () => admin.resolveActor("ops@alpha")),
    { id: "ops", type: "internal" },
  );
  assert.equal(
    withTenant(tenantFor("beta"), () => admin.resolveActor("ops@alpha")),
    null,
  );
});
