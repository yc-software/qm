import { test } from "node:test";
import assert from "node:assert/strict";
import { createWakeSweep, type SweepSource } from "../src/wake/sweep.ts";
import { createEngagedRegistry } from "../src/wake/engaged-registry.ts";

function recordingSource(over: Partial<SweepSource> = {}): { source: SweepSource; swept: string[] } {
  const swept: string[] = [];
  const source: SweepSource = {
    async engagedSessions() {
      return ["A"];
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
  const sweep = createWakeSweep(source, { intervalMs: 10_000 });
  const res = await sweep.sweep();
  assert.deepEqual(swept, ["A"]);
  assert.equal(res.swept, 1);
});

test("a per-session sweep error is caught, not thrown, and later sessions are still swept", async () => {
  const { source, swept } = recordingSource({
    async engagedSessions() {
      return ["A", "B"];
    },
    async sweepSession(threadRef) {
      if (threadRef === "A") throw new Error("surface pull failed");
      swept.push(threadRef);
      return 1;
    },
  });
  const sweep = createWakeSweep(source, { intervalMs: 10_000 });
  const res = await sweep.sweep();
  assert.deepEqual(swept, ["B"]);
  assert.deepEqual(res, { swept: 2, fresh: 1 });
});

test("the engaged registry: engage adds, settle removes, list reflects current (RAM, re-derivable)", () => {
  const reg = createEngagedRegistry();
  assert.deepEqual(reg.list(), []);
  reg.engage("ch:C1:1");
  reg.engage("ch:C1:1");
  reg.engage("ch:C2:2");
  assert.deepEqual(reg.list().sort(), ["ch:C1:1", "ch:C2:2"]);
  reg.settle("ch:C1:1");
  assert.deepEqual(reg.list(), ["ch:C2:2"]);
});

test("nothing engaged ⇒ a pass does no work", async () => {
  const { source, swept } = recordingSource({
    async engagedSessions() {
      return [];
    },
  });
  const sweep = createWakeSweep(source, { intervalMs: 10_000 });
  const res = await sweep.sweep();
  assert.deepEqual(swept, []);
  assert.equal(res.swept, 0);
});
