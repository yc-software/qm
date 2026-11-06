import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { registerFinnyApprovalActions, type FinnyApprovalBridge } from "../src/slack/finny-approvals.ts";
import {
  FINNY_CLARIFICATION_OTHER_ACTION_ID,
  FINNY_PLAN_ACTION_IDS,
  finnyClarificationOptionActionId,
} from "../src/slack/finny-cards.ts";

function deliveryHarness(ageMs = 0, existing: Array<Record<string, unknown>> = []) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const record = (method: string, result: unknown) => async (args: Record<string, unknown>) => {
    calls.push({ method, args });
    return result;
  };
  let claimed = false;
  const delivery = {
    id: "delivery-1",
    destination: { type: "slack", target: "C1:100.200", finnyPlanRequestId: "finny-request-1" },
    text: "Plan approval needed",
    idempotencyKey: "finny-plan:finny-request-1",
    createdAt: Date.now() - ageMs,
  };
  const bridge: FinnyApprovalBridge = {
    pending: async () => ({
      kind: "plan",
      requestId: "finny-request-1",
      card: {
        title: "October close",
        phases: [{ name: "Reconcile", owner: "Producer", dependencies: [] }],
        certification: "Independent PASS",
        deliverable: "Certified pack",
        destination: "This thread",
      },
    }),
    decide: async () => ({ kind: "gone" }),
  };
  const client = {
    conversations: {
      replies: record("conversations.replies", { messages: existing }),
      history: record("conversations.history", { messages: existing }),
    },
    chat: { postMessage: record("chat.postMessage", { ts: "100.300" }) },
  };
  const acknowledged: string[] = [];
  const poller = createDeliveryPoller({
    core: {
      finnyApprovals: bridge,
      holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
      claimDeliveries: async (type: string) => {
        if (type !== "slack" || claimed) return [];
        claimed = true;
        return [delivery];
      },
      ackDelivery: async (id: string) => void acknowledged.push(id),
    } as never,
    flow: { inFlightRuns: new Set<string>() } as never,
    threads: { mark: () => undefined } as never,
    clientForIdentity: () => client,
  });
  return { acknowledged, bridge, calls, client, poller };
}

test("a pending Finny plan delivery uses the durable verified post path", async () => {
  const h = deliveryHarness();
  await h.poller.pollDeliveries(h.client);
  const posted = h.calls.find((call) => call.method === "chat.postMessage")?.args;
  assert.equal(posted?.channel, "C1");
  assert.equal(posted?.thread_ts, "100.200");
  assert.match(JSON.stringify(posted?.blocks), /October close/);
  assert.deepEqual(posted?.metadata, {
    event_type: "qm_delivery",
    event_payload: { idempotency_key: "finny-plan:finny-request-1" },
  });
  assert.deepEqual(h.acknowledged, ["delivery-1"]);
});

test("a pending Finny clarification delivery renders native options and Other", async () => {
  const h = deliveryHarness();
  h.bridge.pending = async () => ({
    kind: "clarification",
    requestId: "finny-request-1",
    card: {
      question: "Which basis should be used?",
      recommendedOptionId: "contracts",
      options: [
        { id: "contracts", label: "Signed contracts" },
        { id: "invoices", label: "Issued invoices" },
      ],
    },
  });
  await h.poller.pollDeliveries(h.client);
  const rendered = JSON.stringify(h.calls.find((call) => call.method === "chat.postMessage")?.args.blocks);
  assert.match(rendered, /Which basis should be used/);
  assert.match(rendered, /Signed contracts/);
  assert.match(rendered, /Other/);
});

test("a recovered Finny plan delivery verifies before it posts again", async () => {
  const existing = [
    {
      ts: "100.300",
      metadata: {
        event_type: "qm_delivery",
        event_payload: { idempotency_key: "finny-plan:finny-request-1" },
      },
    },
  ];
  const h = deliveryHarness(60_000, existing);
  await h.poller.pollDeliveries(h.client);
  assert.equal(
    h.calls.some((call) => call.method === "chat.postMessage"),
    false,
  );
  assert.equal(
    h.calls.some((call) => call.method === "conversations.replies"),
    true,
  );
  assert.deepEqual(h.acknowledged, ["delivery-1"]);
});

function actionHarness(bridge?: FinnyApprovalBridge) {
  let registered: ((args: any) => Promise<void>) | undefined;
  const ephemeral: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const actors: unknown[] = [];
  registerFinnyApprovalActions(
    { action: (_pattern, handler) => void (registered = handler) },
    {
      bridge,
      directory: {
        classifyActor: async (_client: unknown, clickerId: string) => {
          const actor = { externalId: "person@example.com", displayName: clickerId };
          actors.push(actor);
          return actor;
        },
      } as never,
    },
  );
  const client = {
    chat: {
      postEphemeral: async (args: Record<string, unknown>) => void ephemeral.push(args),
      update: async (args: Record<string, unknown>) => void updates.push(args),
    },
  };
  const click = async (action_id: string, value = "request-opaque") => {
    assert.ok(registered);
    await registered({
      ack: async () => undefined,
      action: { action_id, value },
      body: {
        user: { id: "U-clicker" },
        channel: { id: "C-finance" },
        message: { ts: "200.300", thread_ts: "200.100" },
      },
      client,
    });
  };
  return { actors, click, ephemeral, updates };
}

test("Finny plan actions authenticate the clicker and preserve the Slack message context", async () => {
  const decisions: unknown[] = [];
  const bridge: FinnyApprovalBridge = {
    pending: async () => null,
    decide: async (input) => {
      decisions.push(input);
      return {
        kind: "decision",
        card: { title: "October close", decision: "approved", detail: "Execution started." },
      };
    },
  };
  const h = actionHarness(bridge);
  await h.click(FINNY_PLAN_ACTION_IDS.approve);
  assert.deepEqual(decisions, [
    {
      requestId: "request-opaque",
      decision: { kind: "plan", action: "approve" },
      actor: { externalId: "person@example.com", displayName: "U-clicker" },
      slack: { channel: "C-finance", messageTs: "200.300", threadTs: "200.100" },
    },
  ]);
  assert.equal(h.updates.length, 1);
  assert.match(String(h.updates[0]?.text), /Approved/);
  assert.equal(h.ephemeral.length, 0);
});

test("Finny clarification actions pass the selected option while button values stay opaque request IDs", async () => {
  const decisions: unknown[] = [];
  const bridge: FinnyApprovalBridge = {
    pending: async () => null,
    decide: async (input) => {
      decisions.push(input.decision);
      return {
        kind: "result",
        card: { title: "Clarification recorded", status: "passed", summary: "Signed contracts" },
      };
    },
  };
  const h = actionHarness(bridge);
  await h.click(finnyClarificationOptionActionId("signed-contracts"), "request-only");
  await h.click(FINNY_CLARIFICATION_OTHER_ACTION_ID, "other-request");
  assert.deepEqual(decisions, [
    { kind: "clarification", action: "select", optionId: "signed-contracts" },
    { kind: "clarification", action: "other" },
  ]);
  assert.equal(h.updates.length, 2);
});

test("unavailable, gone, and failed Finny actions show retry or expired copy without updating success", async () => {
  const unavailable = actionHarness();
  await unavailable.click(FINNY_PLAN_ACTION_IDS.reject);
  assert.match(String(unavailable.ephemeral[0]?.text), /available right now/i);
  assert.equal(unavailable.updates.length, 0);

  const gone = actionHarness({ pending: async () => null, decide: async () => ({ kind: "gone" }) });
  await gone.click(FINNY_PLAN_ACTION_IDS.reject);
  assert.match(String(gone.ephemeral[0]?.text), /expired|already decided/i);
  assert.equal(gone.updates.length, 0);

  const failed = actionHarness({
    pending: async () => null,
    decide: async () => {
      throw new Error("Core unavailable");
    },
  });
  await failed.click(FINNY_PLAN_ACTION_IDS.requestChange);
  assert.match(String(failed.ephemeral[0]?.text), /try again/i);
  assert.equal(failed.updates.length, 0);
});
