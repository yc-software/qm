import assert from "node:assert/strict";
import test from "node:test";
import { createApprovals } from "../../src/slack/approvals.ts";
import { createTurnFlow } from "../../src/slack/turn-flow.ts";
import { createThreadTracker } from "../../src/slack/message-gating.ts";
import type { SlackCoreClient } from "../../src/api/slack-core-client.ts";
import type { TurnResult } from "../../src/types.ts";

type ActionHandler = (args: any) => Promise<void>;

function fixture() {
  const submitted: any[] = [];
  const posts: any[] = [];
  const state: {
    stored: { requesterId: string; text: string; threadRef?: string } | null;
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
              conversation: {
                kind: "channel",
                threadRef: state.stored.threadRef ?? "ch:C1:1.0",
                channelRef: "C1",
                audience: [],
              },
              deliveryTarget: "C1:1.0",
              text: state.stored.text,
            },
          }
        : null;
    },
  } as unknown as SlackCoreClient;
  const flow = createTurnFlow(core);
  const directory = {
    classifyActor: async (_client: any, userId: string) => ({ externalId: userId, displayName: userId }),
    classifyUserCached: async (_client: any, userId: string) => ({ actor: { externalId: userId } }),
  } as never;
  const approvals = createApprovals({ core, flow, directory, threads: createThreadTracker() });
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
      postMessage: async (body: any) => {
        posts.push(body);
        return { ok: true, ts: "9.9" };
      },
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
        origin: { kind: "direct" },
        actor: { externalId: requesterId },
        conversation: { kind: "channel", threadRef: "ch:C1:1.0", channelRef: "C1", audience: [] },
        deliveryTarget: "C1",
        text,
      },
    });
  };
  return { state, submitted, ephemerals, updates, posts, click, rememberStale };
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

  f.state.result = { status: "ok", reply: "Left it alone." };
  await f.click("U2", "hilo_deny");
  assert.equal(f.submitted.length, 2, "the restored card still denies once the conversation is unblocked");
  assert.match(JSON.stringify(f.updates.at(-1)?.blocks ?? []), /Denied by <@U2>/);
});

test("cold delegated approval resumes the child without posting its reply a second time", async () => {
  const f = fixture();
  f.state.stored = { requesterId: "U2", text: "run delegated command", threadRef: "agent:main:subagent:child" };
  f.state.result = { status: "ok", reply: "delegated result" };
  await f.click("U2");
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].conversation.threadRef, "agent:main:subagent:child");
  assert.equal(f.posts.length, 0);
  assert.match(JSON.stringify(f.updates), /original conversation/);
});

test("a rejected grant scope preserves the same approval card instead of promising a replacement", async () => {
  const f = fixture();
  f.state.result = {
    status: "pending_approval",
    pendingApprovals: [
      {
        requestId: "req-1",
        command: "publish",
        reason: "only once allowed",
        grantModes: { session: false, always: false },
      },
    ],
  };
  await f.click("U2", "hilo_allow_session");
  const last = JSON.stringify(f.updates.at(-1));
  assert.match(last, /hilo_allow_once/);
  assert.doesNotMatch(last, /hilo_allow_session/);
  assert.doesNotMatch(last, /new command needs approval/);
  assert.equal(f.posts.length, 0);
});

test("a deny click replaces the buttons, then shows the continued turn's reply above who denied", async () => {
  const f = fixture();
  let release!: () => void;
  f.state.hold = new Promise<void>((resolve) => (release = resolve));
  f.state.result = { status: "ok", reply: "Understood, I won't run it." };

  const clicked = f.click("U2", "hilo_deny");
  for (let i = 0; i < 20 && !f.submitted.length; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.submitted.length, 1, "the resumed turn is in flight");
  assert.equal(f.updates.length, 1, "the card was rewritten before the turn finished");
  assert.match(String(f.updates[0].text), /^:hourglass_flowing_sand: Denying · `rm -rf \/tmp\/x`…$/);
  assert.equal(JSON.stringify(f.updates[0].blocks).includes("hilo_"), false, "no buttons remain to click again");

  release();
  await clicked;
  const final = f.updates.at(-1);
  assert.equal(final.text, "Understood, I won't run it.");
  const decision = final.blocks.at(-1);
  assert.match(decision.text.text, /^Denied by <@U2> · `rm -rf \/tmp\/x` · <!date\^\d+\^/);
  assert.equal(JSON.stringify(final.blocks).includes("hilo_"), false);
  assert.equal(f.ephemerals.length, 0);
});

test("an allow click shows who allowed it while running and keeps that record under the reply", async () => {
  const f = fixture();
  let release!: () => void;
  f.state.hold = new Promise<void>((resolve) => (release = resolve));
  f.state.result = { status: "ok", reply: "Removed it." };

  const clicked = f.click("U2", "hilo_allow_once");
  for (let i = 0; i < 20 && !f.submitted.length; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.match(
    String(f.updates[0]?.text),
    /^:hourglass_flowing_sand: Allowed once by <@U2> · `rm -rf \/tmp\/x` — running…$/,
  );
  assert.equal(JSON.stringify(f.updates[0].blocks).includes("hilo_"), false);

  release();
  await clicked;
  const final = f.updates.at(-1);
  assert.equal(final.text, "Removed it.");
  const decision = final.blocks.at(-1);
  assert.equal(decision.type, "section");
  assert.match(decision.text.text, /^:white_check_mark: Allowed once by <@U2> · `rm -rf \/tmp\/x` · /);
});

function quarantineFixture(results: { submit: TurnResult; wait: TurnResult | null }) {
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
  const approvals = createApprovals({ core, flow, directory, threads: createThreadTracker() });
  const handlers: Array<{ pattern: RegExp; handler: ActionHandler }> = [];
  approvals.registerActions({ action: (pattern, handler) => void handlers.push({ pattern, handler }) });
  approvals.rememberSlackApprovals([{ requestId: "req-1", command: "rm -rf /tmp/x", reason: "destructive" }], {
    requesterId: "U1",
    channel: "D1",
    approvalChannel: "D1",
    threadOnly: false,
    turn: {
      origin: { kind: "direct" },
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
  const f = quarantineFixture({
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
  const f = quarantineFixture({
    submit: { status: "queued", runId: "R2" },
    wait: { status: "ok", reply: "done" },
  });
  await f.clickApprove();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.flow.inFlightRuns.has("R2"), false);
  assert.match(String(f.updates.at(-1)?.text ?? ""), /done/);
});
