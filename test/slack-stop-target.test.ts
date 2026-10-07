import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnHandler } from "../src/slack/turn-handler.ts";

test("Slack Stop cancels the durable conversation tree even when the coordinator is idle", async () => {
  const stopped: string[] = [];
  const handler = createTurnHandler({
    core: {
      taskAcknowledgements: {},
      stopConversation: async (ref: string) => {
        stopped.push(ref);
        return true;
      },
      activeRunForThread: async () => assert.fail("Stop must not depend on a running coordinator"),
    },
    flow: {
      inFlightRunByThread: new Map(),
      callCore: async () => assert.fail("Stop must not submit another turn"),
    },
    directory: {},
    mirror: {},
    ids: { botUserId: "BOT" },
  } as unknown as Parameters<typeof createTurnHandler>[0]);
  await handler.handleIncoming(
    { kind: "dm", channel: "D1", userId: "U1", actor: { externalId: "U1" }, rawText: "stop", files: [], ts: "10.0" },
    {},
  );
  assert.deepEqual(stopped, ["dm:D1"]);
});
