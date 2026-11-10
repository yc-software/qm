import { test } from "./support/unbound-test.ts";
import assert from "node:assert/strict";
import { createWakeSweep, type SweepSource } from "../src/wake/sweep.ts";
import { createEngagedRegistry } from "../src/wake/engaged-registry.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { currentTenant } from "../src/tenants/context.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";

const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

function recordingSource(over: Partial<SweepSource> = {}): { source: SweepSource; swept: string[] } {
  const swept: string[] = [];
  const source: SweepSource = {
    async engagedSessions() {
      return [{ tenantId: TEST_TENANT, threadRef: "A" }];
    },
    async sweepSession(threadRef) {
      assert.equal(currentTenant(), TEST_TENANT);
      swept.push(threadRef);
      return 1;
    },
    ...over,
  };
  return { source, swept };
}

test("a pass sweeps every engaged session", async () => {
  const { source, swept } = recordingSource();
  const sweep = createWakeSweep(source, { ...singleProcessDeps(), intervalMs: 10_000 });
  const res = await sweep.sweep();
  assert.deepEqual(swept, ["A"]);
  assert.equal(res.swept, 1);
});

test("a per-session sweep error is caught, not thrown (a flaky pull must not kill the loop)", async () => {
  const { source } = recordingSource({
    async sweepSession() {
      throw new Error("surface pull failed");
    },
  });
  const sweep = createWakeSweep(source, { ...singleProcessDeps(), intervalMs: 10_000 });
  await assert.rejects(() => sweep.sweep());
});

test("the engaged registry: engage adds, settle removes, list reflects current (RAM, re-derivable)", () => {
  const reg = createEngagedRegistry();
  const at = (threadRef: string) => ({ tenantId: TEST_TENANT, threadRef });
  const threads = () => reg.list().map(({ threadRef }) => threadRef);
  assert.deepEqual(reg.list(), []);
  reg.engage(at("ch:C1:1"));
  reg.engage(at("ch:C1:1"));
  reg.engage(at("ch:C2:2"));
  assert.deepEqual(threads().sort(), ["ch:C1:1", "ch:C2:2"]);
  reg.settle(at("ch:C1:1"));
  assert.deepEqual(threads(), ["ch:C2:2"]);
});

test("each engaged session is swept under the tenant of the run that engaged it", async () => {
  const reg = createEngagedRegistry();
  reg.engage({ tenantId: TEST_TENANT, threadRef: "ch:C1:1" });
  reg.engage({ tenantId: OTHER_TENANT, threadRef: "ch:C1:1" });
  reg.settle({ tenantId: OTHER_TENANT, threadRef: "ch:C9:9" });
  const seen: string[] = [];
  const sweep = createWakeSweep(
    {
      engagedSessions: async () => reg.list(),
      async sweepSession(threadRef) {
        seen.push(`${currentTenant()} ${threadRef}`);
        return 1;
      },
    },
    { ...singleProcessDeps(), intervalMs: 10_000 },
  );
  assert.deepEqual(await sweep.sweep(), { swept: 2, fresh: 2 });
  assert.deepEqual(seen.sort(), [`${TEST_TENANT} ch:C1:1`, `${OTHER_TENANT} ch:C1:1`]);
});

test("nothing engaged ⇒ a pass does no work", async () => {
  const { source, swept } = recordingSource({
    async engagedSessions() {
      return [];
    },
  });
  const sweep = createWakeSweep(source, { ...singleProcessDeps(), intervalMs: 10_000 });
  const res = await sweep.sweep();
  assert.deepEqual(swept, []);
  assert.equal(res.swept, 0);
});
