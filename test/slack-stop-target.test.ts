import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnHandler } from "../src/slack/turn-handler.ts";

for (const active of ["running-before-account-switch", undefined]) {
  test(`Slack Stop prefers the durable active run over a queued follow-up (${active ?? "cache fallback"})`, async () => {
    const aborted: string[] = [];
    const lookedUp: string[] = [];
    const handler = createTurnHandler({
      core: {
        taskAcknowledgements: {},
        activeRunForThread: async (ref: string) => {
          lookedUp.push(ref);
          return active;
        },
        signalRunAbort: async (id: string) => {
          aborted.push(id);
        },
      },
      flow: {
        inFlightRunByThread: new Map([["dm:D1", "queued-after-account-switch"]]),
        callCore: async () => {
          assert.fail("Stop must not submit another turn");
        },
      },
      directory: {},
      mirror: {},
      ids: { botUserId: "BOT" },
    } as unknown as Parameters<typeof createTurnHandler>[0]);
    await handler.handleIncoming(
      {
        kind: "dm",
        channel: "D1",
        userId: "U1",
        actor: { externalId: "U1" },
        rawText: "stop",
        files: [],
        ts: "10.0",
      },
      {},
    );
    assert.deepEqual(lookedUp, ["dm:D1"]);
    assert.deepEqual(aborted, [active ?? "queued-after-account-switch"]);
  });
}
