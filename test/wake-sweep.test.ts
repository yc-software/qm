import assert from "node:assert/strict";
import { createWakeSweep, type SweepSource } from "../src/wake/sweep.ts";
import { createEngagedRegistry } from "../src/wake/engaged-registry.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { tenantTest } from "./support/test-tenants.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";

function recordingSource(over: Partial<SweepSource> = {}): { source: SweepSource; swept: string[] } {
  const swept: string[] = [];
  const source: SweepSource = {
    async engagedSessions() {
      return [{ threadRef: "A" }];
    },
    async sweepSession(threadRef) {
      swept.push(threadRef);
      return 1;
    },
    ...over,
  };
  return { source, swept };
}

tenantTest("a pass sweeps every engaged session", async () => {
  const { source, swept } = recordingSource();
  const sweep = createWakeSweep(source, { ...singleProcessDeps(), intervalMs: 10_000 });
  const res = await sweep.sweep();
  assert.deepEqual(swept, ["A"]);
  assert.equal(res.swept, 1);
});

tenantTest("a per-session sweep error is caught, not thrown (a flaky pull must not kill the loop)", async () => {
  const { source } = recordingSource({
    async sweepSession() {
      throw new Error("surface pull failed");
    },
  });
  const sweep = createWakeSweep(source, { ...singleProcessDeps(), intervalMs: 10_000 });
  await assert.rejects(() => sweep.sweep());
});

tenantTest("the engaged registry: engage adds, settle removes, list reflects current (RAM, re-derivable)", () => {
  const reg = createEngagedRegistry();
  assert.deepEqual(reg.list(), []);
  reg.engage("ch:C1:1");
  reg.engage("ch:C1:1");
  reg.engage("ch:C2:2");
  assert.deepEqual(
    reg
      .list()
      .map((s) => s.threadRef)
      .sort(),
    ["ch:C1:1", "ch:C2:2"],
  );
  reg.settle("ch:C1:1");
  assert.deepEqual(reg.list(), [{ threadRef: "ch:C2:2" }]);
});

tenantTest("engaged sessions remember their tenant and each is swept under it", async () => {
  const reg = createEngagedRegistry();
  withTenant(A, () => reg.engage("ch:C1:1"));
  withTenant(B, () => reg.engage("ch:C1:1"));
  assert.deepEqual(
    reg.list().map((s) => s.tenantId),
    [A, B],
  );
  const seen: Array<[string | undefined, string]> = [];
  const sweep = createWakeSweep(
    {
      engagedSessions: async () => reg.list(),
      async sweepSession(threadRef) {
        seen.push([boundTenant(), threadRef]);
        reg.settle(threadRef);
        return 1;
      },
    },
    { ...singleProcessDeps(), intervalMs: 10_000 },
  );
  await sweep.sweep();
  assert.deepEqual(seen, [
    [A, "ch:C1:1"],
    [B, "ch:C1:1"],
  ]);
  assert.deepEqual(reg.list(), []);
});

tenantTest("nothing engaged ⇒ a pass does no work", async () => {
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
