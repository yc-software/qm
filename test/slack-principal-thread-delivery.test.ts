import test from "node:test";
import assert from "node:assert/strict";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";

const TS = "1723497600.123456";

test("a threaded principal delivery posts and records the DM thread", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const acks: Array<{ id: string; body: unknown }> = [];
  let claimed = false;
  const delivery = {
    id: "delivery-1",
    destination: { type: "principal", target: "U-alice", threadTs: TS },
    text: "in the DM thread",
    idempotencyKey: "reach:1",
    createdAt: Date.now(),
    deliveredAt: null,
  };
  const client = {
    conversations: { open: async () => ({ channel: { id: "D-alice" } }) },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ts: "1723497601.000001" };
      },
    },
  };
  const poller = createDeliveryPoller({
    core: {
      claimDeliveries: async (type: string) => {
        if (type !== "principal" || claimed) return [];
        claimed = true;
        return [delivery];
      },
      ackDelivery: async (id: string, body: unknown) => void acks.push({ id, body }),
    } as any,
    bridge: {
      inFlightRuns: new Set(),
      fetchBlobFromCore: async () => new Uint8Array(),
      fetchFileArtifactFromCore: async () => new Uint8Array(),
    } as any,
    mirror: { mirrorSelfPost: () => undefined } as any,
    threads: { mark: () => undefined } as any,
    clientForIdentity: () => client,
  });

  await poller.pollDeliveries(client);

  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channel, "D-alice");
  assert.equal(posts[0]!.thread_ts, TS);
  assert.equal(acks.length, 1);
  assert.equal(acks[0]!.id, "delivery-1");
  assert.equal((acks[0]!.body as { recipientThreadRef?: string }).recipientThreadRef, `dm:D-alice:${TS}`);
});
