import assert from "node:assert/strict";
import test from "node:test";
import { createApprovals } from "../src/slack/approvals.ts";
import { createTurnFlow } from "../src/slack/turn-flow.ts";
import { createThreadTracker } from "../src/slack/lib.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { TurnResult } from "../src/types.ts";

type ActionHandler = (args: any) => Promise<void>;

function fixture() {
  const submitted: any[] = [];
  const state: {
    stored: { requesterId: string; text: string } | null;
    result: TurnResult;
    hold: Promise<void> | null;
    fetchFails: boolean;
  } = {
    stored: { requesterId: "U2", text: "please run it" },
    result: { status: "ok", reply: "done" },
    hold: null,
    fetchFails: false,
  };
  const core = {
    submitTurn: async (body: any) => {
      submitted.push(body);
      if (state.hold) await state.hold;
      return state.result;
    },
    waitRun: async () => null,
    ackRunDelivery: async () => {},
    reportRunEditRef: async () => {},
    getApproval: async () => {
      if (state.fetchFails) throw new Error("core unreachable");
      return state.stored
        ? {
            requestId: "req-1",
            command: "rm -rf /tmp/x",
            reason: "destructive",
            request: {
              actor: { externalId: state.stored.requesterId },
              conversation: { kind: "channel", threadRef: "ch:C1:1.0", channelRef: "C1", audience: [] },
              deliveryTarget: "C1:1.0",
              text: state.stored.text,
            },
          }
        : null;
    },
    agentRequestForApproval: async () => null,
  } as unknown as SlackCoreClient;
  const flow = createTurnFlow(core);
  const directory = {
    classifyActor: async (_client: any, userId: string) => ({ externalId: userId, displayName: userId }),
    classifyUserCached: async (_client: any, userId: string) => ({ actor: { externalId: userId } }),
  } as never;
  const approvals = createApprovals({ core, flow, directory, threads: createThreadTracker(), ids: {} as never });
  const handlers: Array<{ pattern: RegExp; handler: ActionHandler }> = [];
  approvals.registerActions({ action: (pattern, handler) => void handlers.push({ pattern, handler }) });
  const ephemerals: any[] = [];
  const updates: any[] = [];
  const client = {
    chat: {
      update: async (body: any) => {
        updates.push(body);
        return { ok: true };
      },
      postMessage: async () => ({ ok: true, ts: "9.9" }),
      postEphemeral: async (body: any) => {
        ephemerals.push(body);
        return { ok: true };
      },
    },
  };
  const click = async (clickerId: string, actionId = "hilo_allow_once"): Promise<void> => {
    const hilo = handlers.find((h) => h.pattern.test(actionId))!;
    await hilo.handler({
      ack: async () => {},
      body: { user: { id: clickerId }, channel: { id: "C1" }, message: { ts: "1.0" } },
      action: { action_id: actionId, value: "req-1" },
      client,
    });
  };
  const rememberStale = (requesterId: string, text: string): void => {
    approvals.rememberSlackApprovals([{ requestId: "req-1", command: "rm -rf /tmp/x", reason: "destructive" }], {
      requesterId,
      channel: "C1",
      approvalChannel: "C1",
      threadOnly: false,
      turn: {
        actor: { externalId: requesterId },
        conversation: { kind: "channel", threadRef: "ch:C1:1.0", channelRef: "C1", audience: [] },
        deliveryTarget: "C1",
        text,
      },
    });
  };
  return { state, submitted, ephemerals, updates, click, rememberStale };
}

test("a click resumes from the stored record, not from whatever the card registry last cached", async () => {
  const f = fixture();
  f.rememberStale("U1", "any update on that?");

  await f.click("U1");
  assert.equal(f.submitted.length, 0, "the stale cached requester no longer resolves this approval");
  assert.match(f.ephemerals[0]?.text ?? "", /Only the person who requested/);

  await f.click("U2");
  assert.equal(f.submitted.length, 1, "the record's requester resumes the turn");
  assert.equal(f.submitted[0].text, "please run it", "the resume replays the record's request, not the cached re-post");
  assert.equal(f.submitted[0].approval.requestId, "req-1");
  assert.equal(f.submitted[0].approval.approved, true);
});

test("a click on a card whose record is already consumed reports expiry instead of submitting a doomed turn", async () => {
  const f = fixture();
  f.state.stored = null;
  f.rememberStale("U1", "please run it");

  await f.click("U1");
  assert.equal(f.submitted.length, 0);
  assert.match(String(f.updates[0]?.text ?? ""), /approval request expired/);
});

test("a second click while the approved turn is still running says still-working, never expired", async () => {
  const f = fixture();
  let release!: () => void;
  f.state.hold = new Promise<void>((resolve) => (release = resolve));

  const firstClick = f.click("U2");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.submitted.length, 1, "the first click is in flight");

  f.state.stored = null;
  await f.click("U2");
  assert.match(f.ephemerals[0]?.text ?? "", /being resolved right now/);
  assert.doesNotMatch(
    f.ephemerals[0]?.text ?? "",
    /person who requested/,
    "the peek claims nothing about who clicked — it has only a possibly-stale cached requester",
  );
  assert.equal(
    f.updates.some((u) => /expired/.test(String(u.text ?? ""))),
    false,
    "the live card is never rewritten to expired while the turn runs",
  );

  release();
  await firstClick;
  assert.match(String(f.updates.at(-1)?.text ?? ""), /done/);
});

test("an approval sealed behind another pending approval keeps an honest, live card", async () => {
  const f = fixture();
  f.state.result = {
    status: "pending_approval",
    sessionId: "S1",
    reason: "This conversation is waiting for someone else to resolve a pending approval.",
  };

  await f.click("U2");
  assert.equal(f.submitted.length, 1);
  const card = f.updates.at(-1);
  assert.match(String(card?.text ?? ""), /waiting for someone else/);
  const buttonValues = JSON.stringify(card?.blocks ?? []);
  assert.match(buttonValues, /req-1/, "the re-rendered card keeps live buttons for the real request");
  assert.doesNotMatch(buttonValues, /unknown command/);

  f.state.fetchFails = true;
  f.state.result = { status: "ok", reply: "done" };
  await f.click("U2");
  assert.equal(
    f.submitted.length,
    2,
    "sealedOut re-registered the card, so it resolves even while the record fetch is failing",
  );
  assert.match(String(f.updates.at(-1)?.text ?? ""), /done/);
});

test("a sealed-out deny never claims the command was denied", async () => {
  const f = fixture();
  f.state.result = {
    status: "pending_approval",
    sessionId: "S1",
    reason: "This conversation is waiting for someone else to resolve a pending approval.",
  };

  await f.click("U2", "hilo_deny");
  assert.equal(f.submitted.length, 1);
  assert.equal(
    f.updates.some((u) => /Denied/.test(String(u.text ?? ""))),
    false,
    "the card must not report a denial that never reached the record",
  );
  assert.match(String(f.updates.at(-1)?.text ?? ""), /waiting for someone else/);

  f.state.result = { status: "refused", reason: "approval denied for rm -rf /tmp/x" };
  await f.click("U2", "hilo_deny");
  assert.equal(f.submitted.length, 2, "the restored card still denies once the conversation is unblocked");
  assert.match(String(f.updates.at(-1)?.text ?? ""), /Denied/);
});
