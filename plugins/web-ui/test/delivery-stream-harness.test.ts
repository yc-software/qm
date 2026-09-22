import assert from "node:assert/strict";
import test from "node:test";
import { openDeliveryStreamHarness } from "./helpers/delivery-stream-harness.ts";

const session = {
  id: "s1",
  threadRef: "web:owner:harness",
  scopeId: "personal:owner",
  title: "Harness chat",
  type: "dm" as const,
  createdAt: Date.now(),
};
const options = {
  sessions: [session],
  transcript: () => [],
  activeRun: () => ({ runId: null, run: null, queued: [] }),
};

test("the shared delivery-stream harness leaves the process as it found it", async (t) => {
  await t.test("catches a boot failure that leaves the fetch stub installed on globalThis", async () => {
    const realFetch = globalThis.fetch;
    await assert.rejects(
      openDeliveryStreamHarness({ ...options, sessions: [] }).then((harness) => harness.dispose()),
      "a harness that cannot boot must reject instead of handing back a half-built page",
    );
    assert.equal(globalThis.fetch, realFetch, "a failed boot must restore the fetch it replaced");
  });

  await t.test("catches a stream registry shared by every harness in the process", async () => {
    const first = await openDeliveryStreamHarness(options);
    await first.dispose();
    const second = await openDeliveryStreamHarness(options);
    try {
      assert.deepEqual(
        second.streams.map((stream) => stream.url),
        ["/api/deliveries/events"],
        "a fresh harness must see only the streams it opened itself",
      );
    } finally {
      await second.dispose();
    }
  });
});
