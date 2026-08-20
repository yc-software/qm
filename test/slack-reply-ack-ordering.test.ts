import { test } from "node:test";
import assert from "node:assert";
import { createCoreBridge } from "../src/slack/core-bridge.ts";
import { createDeliveryTracker, deliverWithRetry } from "../src/slack/delivery.ts";

function fakeCore(pending: Map<string, { text: string }>, events: string[]) {
  return {
    async submitTurn() {
      pending.set("run:r1", { text: "the finished reply" });
      return { status: "queued", runId: "r1" };
    },
    async waitRun() {
      return { status: "ok", reply: "the finished reply", runId: "r1" };
    },
    async ackRunDelivery(runId: string) {
      events.push("ack");
      pending.delete(`run:${runId}`);
    },
    async signalRunAbort() {},
    async activeRunForThread() {
      return undefined;
    },
    async stageBlob() {
      return { blobId: "b", sizeBytes: 0 };
    },
    async readBlob() {
      return Buffer.alloc(0);
    },
    async readFileArtifact() {
      return Buffer.alloc(0);
    },
    async reportTurnMetrics() {},
    async reportRunEditRef() {},
  } as any;
}

/** Regression: an ok run must NOT ack its recovery delivery before the caller posts the
 *  reply to Slack. With deferOkAck the bridge leaves the delivery pending; a post failure
 *  releases the run pin and the poller can still redeliver — the reply is never lost. */
test("deferOkAck: recovery delivery stays pending until the caller settles it", async () => {
  const events: string[] = [];
  const pending = new Map<string, { text: string }>();
  const bridge = createCoreBridge(fakeCore(pending, events));

  const result = await bridge.callCore({ text: "hi" } as any, { deferOkAck: true });
  assert.equal(result.status, "ok");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, [], "no ack before the reply is posted");
  assert.ok(pending.has("run:r1"), "recovery copy still pending — a failed post is recoverable");
  assert.ok(bridge.inFlightRuns.has("r1"), "run stays pinned so the poller waits for the handler");

  // handler posts to Slack, then settles:
  bridge.ackRunDeliveryWithRetry("r1");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ["ack"]);
  assert.equal(pending.size, 0);
  assert.equal(bridge.inFlightRuns.has("r1"), false, "pin released after settle");
});

/** Callers that don't opt in (approvals) keep the old behavior: ok acks immediately. */
test("without deferOkAck an ok run still acks its recovery delivery", async () => {
  const events: string[] = [];
  const pending = new Map<string, { text: string }>();
  const bridge = createCoreBridge(fakeCore(pending, events));
  await bridge.callCore({ text: "hi" } as any);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ["ack"]);
  assert.equal(pending.size, 0);
});

/** Regression: the poller's give-up is a timed bench, not a permanent abandonment.
 *  After maxAttempts failures the delivery is skipped only until giveUpRetryMs passes;
 *  then delivery resumes, so a pending DB row can't be stranded silently forever. */
test("delivery tracker retries a given-up delivery after the bench window", async () => {
  const tracker = createDeliveryTracker({ giveUpRetryMs: 50 });
  let posts = 0;
  let acked = false;
  const failing = {
    tracker,
    id: "d1",
    post: async () => {
      posts++;
      throw new Error("slack 429");
    },
    ack: async () => {
      acked = true;
    },
    onError: () => {},
  };
  for (let i = 0; i < 6; i++) await deliverWithRetry(failing);
  assert.equal(posts, 5, "benched after 5 attempts");

  // Slack recovers; within the bench window nothing happens…
  const healthy = {
    ...failing,
    post: async () => {
      posts++;
    },
  };
  await deliverWithRetry(healthy);
  assert.equal(posts, 5);
  // …but after it expires, delivery resumes and completes.
  await new Promise((r) => setTimeout(r, 60));
  await deliverWithRetry(healthy);
  assert.equal(posts, 6, "retried after the bench expired");
  assert.equal(acked, true, "delivery finally acked");
});
