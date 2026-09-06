import assert from "node:assert/strict";
import test from "node:test";
import { createApprovals } from "../src/slack/approvals.ts";
import { createTurnFlow } from "../src/slack/turn-flow.ts";
import { createThreadTracker } from "../src/slack/lib.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { TurnResult } from "../src/types.ts";

type ActionHandler = (args: any) => Promise<void>;

function fixture(results: { submit: TurnResult; wait: TurnResult | null }) {
  const pinnedDuringWait: boolean[] = [];
  const events: string[] = [];
  const core = {
    submitTurn: async () => results.submit,
    waitRun: async (runId: string) => {
      pinnedDuringWait.push(flow.inFlightRuns.has(runId));
      return results.wait;
    },
    ackRunDelivery: async (runId: string) => void events.push(`ack:${runId}`),
    reportRunEditRef: async () => {},
  } as unknown as SlackCoreClient;
  const flow = createTurnFlow(core);
  const directory = {
    classifyActor: async () => ({ externalId: "U1", displayName: "Alice" }),
    classifyUserCached: async () => ({ actor: { externalId: "U1", displayName: "Alice" } }),
  } as never;
  const approvals = createApprovals({ core, flow, directory, threads: createThreadTracker(), ids: {} as never });
  const handlers: Array<{ pattern: RegExp; handler: ActionHandler }> = [];
  approvals.registerActions({ action: (pattern, handler) => void handlers.push({ pattern, handler }) });
  approvals.rememberSlackApprovals([{ requestId: "req-1", command: "rm -rf /tmp/x", reason: "destructive" }], {
    requesterId: "U1",
    channel: "D1",
    approvalChannel: "D1",
    threadOnly: false,
    turn: {
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:D1", audience: [{ externalId: "U1" }] },
      deliveryTarget: "D1",
      text: "please run it",
    },
  });
  const updates: any[] = [];
  const client = {
    chat: {
      update: async (body: any) => {
        updates.push(body);
        events.push(`card:${String(body?.text ?? "")}`);
      },
      postMessage: async () => ({ ok: true, ts: "9.9" }),
      postEphemeral: async () => ({ ok: true }),
    },
  };
  const clickApprove = async (): Promise<void> => {
    const hilo = handlers.find((h) => h.pattern.test("hilo_allow_once"))!;
    await hilo.handler({
      ack: async () => {},
      body: { user: { id: "U1" }, channel: { id: "D1" }, message: { ts: "1.0" } },
      action: { action_id: "hilo_allow_once", value: "req-1" },
      client,
    });
  };
  return { flow, updates, events, pinnedDuringWait, clickApprove };
}

test("an approved resume that comes back security-quarantined acks the delivery after the card conveys it", async () => {
  const f = fixture({
    submit: { status: "queued", runId: "R1" },
    wait: { status: "refused", refusalKind: "security_quarantine", reason: "quarantined" },
  });
  await f.clickApprove();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.pinnedDuringWait, [true], "the run is pinned while the approval handler waits on it");
  const cardIndex = f.events.findIndex((e) => /can't continue/.test(e));
  const ackIndex = f.events.indexOf("ack:R1");
  assert.notEqual(cardIndex, -1, "the card conveys the refusal");
  assert.notEqual(ackIndex, -1, "the delivery row is acked so the poller does not re-post the notice");
  assert.ok(ackIndex > cardIndex, "the ack lands only after the card conveys the refusal (post-then-ack)");
  assert.equal(f.flow.inFlightRuns.has("R1"), false, "the pin is released, so nothing leaks until restart");
});

test("an approved resume that succeeds leaves no pin behind either", async () => {
  const f = fixture({
    submit: { status: "queued", runId: "R2" },
    wait: { status: "ok", reply: "done" },
  });
  await f.clickApprove();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.flow.inFlightRuns.has("R2"), false);
  assert.match(String(f.updates.at(-1)?.text ?? ""), /done/);
});
