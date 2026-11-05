import { test } from "node:test";
import assert from "node:assert/strict";
import { createWakeSweep, type SweepSource } from "../src/wake/sweep.ts";
import { createEngagedRegistry } from "../src/wake/engaged-registry.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";

const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function recordingSource(over: Partial<SweepSource> = {}): { source: SweepSource; swept: string[] } {
  const swept: string[] = [];
  const source: SweepSource = {
    async engagedSessions() {
      return [{ tenantId: TENANT, threadRef: "A" }];
    },
    async sweepSession(threadRef) {
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
  const refs = () => reg.list().map((session) => session.threadRef);
  assert.deepEqual(refs(), []);
  withTenant(TENANT, () => {
    reg.engage("ch:C1:1");
    reg.engage("ch:C1:1");
    reg.engage("ch:C2:2");
  });
  assert.deepEqual(refs().sort(), ["ch:C1:1", "ch:C2:2"]);
  withTenant(TENANT, () => reg.settle("ch:C1:1"));
  assert.deepEqual(refs(), ["ch:C2:2"]);
});

test("engaged sessions are kept per tenant and swept under their own tenant", async () => {
  const reg = createEngagedRegistry();
  withTenant(TENANT, () => reg.engage("ch:C1:1"));
  withTenant(OTHER, () => reg.engage("ch:C1:1"));
  withTenant(OTHER, () => reg.settle("ch:C1:1"));
  assert.deepEqual(reg.list(), [{ tenantId: TENANT, threadRef: "ch:C1:1" }]);
  withTenant(OTHER, () => reg.engage("ch:C9:9"));
  const seen: Array<[string | undefined, string]> = [];
  const sweep = createWakeSweep(
    {
      engagedSessions: async () => reg.list(),
      async sweepSession(threadRef) {
        seen.push([boundTenant(), threadRef]);
        return 0;
      },
    },
    { ...singleProcessDeps(), intervalMs: 10_000 },
  );
  await sweep.sweep();
  assert.deepEqual(seen, [
    [TENANT, "ch:C1:1"],
    [OTHER, "ch:C9:9"],
  ]);
  assert.throws(() => reg.engage("ch:C1:1"), /No tenant is bound/);
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
