import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrandingCache } from "../plugins/chassis/src/branding.ts";
import { boundTenant, withTenant, withoutTenant } from "../plugins/chassis/src/tenant.ts";

const TENANT_A = "3f1c7a52-9d4e-4b8a-a6f0-2c5e8d1b7a93";
const TENANT_B = "8a2d4c6e-1b3f-4a5c-9e7d-0f2b4d6a8c1e";

test("each tenant's sign-in pages see only that tenant's branding, and an unbound render fetches none", async () => {
  const fetchedFor: Array<string | undefined> = [];
  const cache = createBrandingCache(async () => {
    fetchedFor.push(boundTenant());
    return { selfLabel: `label of ${boundTenant()}` };
  });
  assert.deepEqual(await withoutTenant(() => cache.forRender()), {});
  assert.deepEqual(await withTenant(TENANT_A, () => cache.forRender()), { selfLabel: `label of ${TENANT_A}` });
  assert.deepEqual(await withTenant(TENANT_B, () => cache.forRender()), { selfLabel: `label of ${TENANT_B}` });
  assert.deepEqual(
    withTenant(TENANT_A, () => cache.current()),
    { selfLabel: `label of ${TENANT_A}` },
  );
  assert.deepEqual(fetchedFor, [TENANT_A, TENANT_B]);
});
