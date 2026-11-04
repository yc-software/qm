import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackCoreClient } from "../src/api/slack-core-client.ts";
import { registerTenants, withTenant } from "../src/tenants/context.ts";

test("each tenant's Slack delivery dispatch and directory sync hold their own lease", async () => {
  const install = "00000000-0000-4000-8000-000000000001";
  const company = "00000000-0000-4000-8000-000000000002";
  const keys: string[] = [];
  const core = createSlackCoreClient({
    leaderLease: {
      hold: async (key: string, fn: (lost: Promise<void>) => Promise<unknown>) => {
        keys.push(key);
        return fn(new Promise(() => {}));
      },
    },
  } as unknown as Parameters<typeof createSlackCoreClient>[0]);
  registerTenants(install, undefined);
  for (const tenant of [install, company])
    await withTenant(tenant, async () => {
      await core.holdDeliveryDispatch(async () => true);
      await core.holdDirectorySync(async () => true);
    });
  assert.deepEqual(keys, [
    "slack:delivery-dispatch",
    "slack:directory-sync",
    `slack:delivery-dispatch:tenant:${company}`,
    `slack:directory-sync:tenant:${company}`,
  ]);
});
