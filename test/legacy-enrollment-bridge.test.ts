import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyEnrollmentBridge } from "../src/runs/instance-registry.ts";

test("legacy enrollment publishes only when admitted and ignores legacy supersession", async () => {
  let eligible = false;
  let beats = 0;
  const bridge = createLegacyEnrollmentBridge(
    {
      beat: async () => {
        beats++;
        return true;
      },
    },
    async () => eligible,
  );
  assert.equal(await bridge.beat(), false);
  assert.equal(beats, 0);
  eligible = true;
  assert.equal(await bridge.beat(), false);
  assert.equal(beats, 1);
  eligible = false;
  assert.equal(await bridge.beat(), false);
  assert.equal(beats, 1);
});

test("legacy enrollment propagates failed eligibility reads without publishing", async () => {
  let beats = 0;
  const bridge = createLegacyEnrollmentBridge(
    {
      beat: async () => {
        beats++;
        return false;
      },
    },
    async () => {
      throw new Error("database unavailable");
    },
  );
  await assert.rejects(bridge.beat(), /database unavailable/);
  assert.equal(beats, 0);
});
