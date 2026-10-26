import test from "node:test";
import assert from "node:assert/strict";
import { createSlackSender } from "../src/slack/sender.ts";

const TS = "1723497600.123456";

test("a threaded principal post lands in the DM thread and returns that thread", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    conversations: { open: async () => ({ channel: { id: "D-alice" } }) },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ts: "1723497601.000001" };
      },
    },
  };
  const send = createSlackSender({
    core: {} as never,
    flow: { inFlightRuns: new Set<string>() } as never,
    threads: { mark: () => undefined } as never,
    clientForIdentity: () => client,
    defaultClient: client,
  });

  const receipt = await send({
    destination: { type: "principal", target: "U-alice", threadTs: TS },
    text: "in the DM thread",
    idempotencyKey: "reach:1",
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channel, "D-alice");
  assert.equal(posts[0]!.thread_ts, TS);
  assert.deepEqual(receipt, { recipientThreadRef: `dm:D-alice:${TS}` });
});
