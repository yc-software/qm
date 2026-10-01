import assert from "node:assert/strict";
import test from "node:test";
import { createLegacyEnrollmentBridge } from "../src/runs/instance-registry.ts";

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
