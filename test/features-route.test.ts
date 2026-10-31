import assert from "node:assert/strict";
import { test } from "node:test";
import { featureRoutes } from "../src/api/routes/features.ts";
import { testFeatureFlagStore } from "./support/typed-stores.ts";
import { testMap } from "./support/test-database.ts";
import { scopeId } from "../src/types.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { TEST_ROOT_SCOPE } from "./support/tenant.ts";

const flags = testFeatureFlagStore();
await flags.setEnabled("web_ui", TEST_ROOT_SCOPE, true, "admin");
await flags.setEnabled("voice", scopeId("personal", "alice"), true, "admin");

async function features(query: string, actor?: string) {
  let status = 0;
  let data: unknown;
  await featureRoutes[0]!.handle({
    url: new URL(`http://core/v1/features?${query}`),
    actor: actor ? { p: actor } : null,
    deps: { featureFlags: flags },
    res: {
      getHeader: () => undefined,
      writeHead: (value: number) => void (status = value),
      end: (value: string) => void (data = JSON.parse(value)),
    },
  } as unknown as ApiCtx);
  return { status, data };
}

test("features lists the person's flags, including org-wide ones", async () => {
  assert.deepEqual(await features("principalId=alice"), { status: 200, data: { enabled: ["voice", "web_ui"] } });
  assert.deepEqual(await features("principalId=bob"), { status: 200, data: { enabled: ["web_ui"] } });
});

test("a verified portal actor reads only their own flags", async () => {
  assert.deepEqual(await features("principalId=alice", "bob"), { status: 200, data: { enabled: ["web_ui"] } });
});

test("features needs a principal", async () => {
  assert.equal((await features("principalId=%20")).status, 400);
});
