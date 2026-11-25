import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshApp, internalActor, dm, channel } from "./support/orchestrator-app.ts";
import { mockHeldTurns } from "./support/mock-agent.ts";
import { approvalCardId } from "../src/core/approval-id.ts";
import {
  BOT_REQUESTER_APPROVAL_NOTE,
  BOT_REQUESTER_REFUSAL,
  undeliverableApprovalNote,
} from "../src/core/approval-requester.ts";
import { scopeId } from "../src/types.ts";
import { withCommandRules } from "./support/command-rules.ts";
import { isHidden, isUserItem } from "../src/sessions/items.ts";
import { principalDestination } from "../src/reach/reach.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

test("read/write round-trip through the workspace", async () => {
  const { app } = freshApp();
  const w = await app.turn(dm("!write notes.md hello-workspace"));
  assert.equal(w.status, "ok");
  const r = await app.turn(dm("!read notes.md"));
  assert.equal(r.status, "ok");
  assert.match(r.reply ?? "", /hello-workspace/);
});

test("an approval pause persists timing on its boundary entry", async () => {
  const { app } = freshApp();
  const before = Date.now();
  const first = await app.turn(dm("!paused-approval git push --force origin main"));
  assert.equal(first.status, "ok");
  assert.ok(first.pendingApprovals?.length);
  const paused = await app.getSession(first.sessionId!);
  const boundary = paused!.items.findLast((item) => item.body.blocked === "needs_approval");
  assert.ok(boundary);
  const timing = boundary.body as { workStartedAt: number; workFinishedAt: number };
  assert.ok(timing.workStartedAt >= before);
  assert.ok(timing.workFinishedAt >= timing.workStartedAt);
  assert.ok(timing.workFinishedAt <= boundary.createdAt);
});

test("dangerous command pauses for HiLO approval, then proceeds when approved", async () => {
  const { app } = await withCommandRules(freshApp());
  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals?.[0];
  assert.ok(pending);
  assert.match(pending!.reason, /force push/);

  const approved = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending!.requestId, approved: true },
    }),
  );
  assert.equal(approved.status, "ok");

  const found = await app.getSession(approved.sessionId!);
  const userEntries = found!.items.filter(isUserItem);
  assert.equal(userEntries.length, 2, "the approval continuation re-records the turn input");
  const [original, replay] = userEntries as [(typeof userEntries)[0], (typeof userEntries)[0]];
  assert.notEqual(isHidden(original), true, "the human's original message stays visible");
  assert.equal(
    isHidden(replay),
    true,
    "the continuation's replay is hidden so the chat never shows the human saying it twice",
  );
});

test("a bot-requested turn never opens an approval when a command is gated", async () => {
  const built = await withCommandRules(freshApp());
  const res = await built.app.turn(dm("!run git push --force origin main", { botActor: true }));
  assert.equal(res.status, "refused");
  assert.equal(res.reason, BOT_REQUESTER_REFUSAL);
  assert.equal(res.pendingApprovals, undefined);
  assert.equal((await built.deliveries.pending("principal")).length, 0);
});

test("a bot-requested turn tells the agent that approvals are unavailable", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!approval-note", { botActor: true }));
  assert.equal(res.status, "ok");
  assert.equal(res.reply, BOT_REQUESTER_APPROVAL_NOTE);
  assert.equal((await app.turn(dm("!approval-note"))).reply, "approvals available");
});

test("a command-approval card that fails terminally settles the approval as declined", async () => {
  const built = await withCommandRules(freshApp());
  const first = await built.app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const requestId = first.pendingApprovals![0]!.requestId;
  const card = await built.deliveries.enqueue({
    destination: { ...principalDestination("U1", "U1"), commandApprovalId: requestId },
    text: "Approval needed",
    idempotencyKey: "test-card",
  });
  await built.app.failDelivery(card.id, "cannot_dm_bot");
  assert.equal(await built.app.getApproval(requestId), null);
  const items = (await built.app.getSession(first.sessionId!))!.items;
  const decision = items.find((item) => item.kind === "ElicitationResponse" && item.elicitId === requestId);
  assert.equal(decision?.approved, false);
  assert.ok(
    items.some((item) => isHidden(item) && (item.text ?? "").startsWith(undeliverableApprovalNote("cannot_dm_bot"))),
  );
  const follow = await built.app.turn(dm("what happened?"));
  assert.notEqual(follow.status, "pending_approval");
});

test("a pending command approval doesn't hold up follow-up input in the same thread", async () => {
  const { app } = await withCommandRules(freshApp());
  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const followUp = await app.turn(dm("actually, what were we doing?"));
  assert.equal(followUp.status, "ok");
  assert.equal(followUp.sessionId, first.sessionId);

  const found = await app.getSession(first.sessionId!);
  assert.equal(
    found!.items.some((e) => isUserItem(e) && (e.text ?? "").includes("what were we doing")),
    true,
    "the follow-up runs in the same conversation",
  );

  const approved = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true },
    }),
  );
  assert.equal(approved.status, "ok");
});

test("a second click on an already-consumed approval refuses instead of re-running the command", async () => {
  const { app, auditLog } = await withCommandRules(freshApp());
  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const approved = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true, scope: "session" },
    }),
  );
  assert.equal(approved.status, "ok");

  const again = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true, scope: "session" },
    }),
  );
  assert.equal(again.status, "refused", "a consumed approval must never fall through to a fresh full turn");
  assert.match(again.reason ?? "", /approval request expired/);

  const found = await app.getSession(approved.sessionId!);
  const userEntries = found!.items.filter(isUserItem);
  assert.equal(userEntries.length, 2, "the duplicate click never replays the gated command");

  const refusal = (await auditLog.events(tenant)).find(
    (event) => event.action === "command_approval.approve" && event.status === "refused",
  );
  assert.match(refusal?.detail ?? "", /expired/, "the refusal is audited as an expired-approval attempt");
});

test("an approval id from another conversation refuses there and stays approvable where it was requested", async () => {
  const { app, auditLog } = await withCommandRules(freshApp());
  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const elsewhere = await app.turn(
    dm("!run git push --force origin main", {
      conversation: { kind: "dm", threadRef: "dm:U1:t2" },
      approval: { requestId: pending.requestId, approved: true },
    }),
  );
  assert.equal(elsewhere.status, "refused");
  assert.match(elsewhere.reason ?? "", /approval request expired/);
  const refusal = (await auditLog.events(tenant)).find(
    (event) => event.action === "command_approval.approve" && event.status === "refused",
  );
  assert.match(refusal?.detail ?? "", /foreign_session/, "the audit distinguishes a cross-conversation replay");

  const approved = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true },
    }),
  );
  assert.equal(approved.status, "ok", "the misdirected click left the original approval intact");
});

test("a bystander presenting someone else's blocking requestId stays sealed out and consumes nothing", async () => {
  const { app, auditLog } = await withCommandRules(freshApp());
  const bystander = { externalId: "U2" };
  const first = await app.turn(channel("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const hijackApprove = await app.turn(
    channel("!run git push --force origin main", {
      actor: bystander,
      approval: { requestId: pending.requestId, approved: true, scope: "always" },
    }),
  );
  assert.equal(hijackApprove.status, "pending_approval", "the seal holds — no turn runs for the bystander");
  assert.equal(hijackApprove.pendingApprovals, undefined, "and the seal reveals nothing about the request");

  const hijackDeny = await app.turn(
    channel("!run git push --force origin main", {
      actor: bystander,
      approval: { requestId: pending.requestId, approved: false },
    }),
  );
  assert.equal(hijackDeny.status, "pending_approval");
  assert.equal(hijackDeny.pendingApprovals, undefined);

  const sealedRefusals = (await auditLog.events(tenant)).filter(
    (event) => event.principalId === "U2" && event.status === "refused" && event.action.startsWith("command_approval."),
  );
  assert.equal(sealedRefusals.length, 2, "both sealed-thread hijack attempts leave an audit trail");
  for (const refusal of sealedRefusals) assert.match(refusal.detail ?? "", /sealed_thread/);

  const approved = await app.turn(
    channel("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true },
    }),
  );
  assert.equal(approved.status, "ok", "the bystander's clicks neither granted nor destroyed the approval");
});

test("only the requester can approve or deny a collected approval; a bystander is refused and audited", async () => {
  const { app, auditLog } = freshApp();
  const bystander = { externalId: "U2" };
  const first = await app.turn(channel("!collect-approval zz-cmd"));
  assert.equal(first.status, "ok");
  const pending = first.pendingApprovals![0]!;
  assert.equal(pending.blocksInput, false, "a collected approval does not seal the thread");

  const hijackApprove = await app.turn(
    channel("run it already", {
      actor: bystander,
      approval: { requestId: pending.requestId, approved: true, scope: "always" },
    }),
  );
  assert.equal(hijackApprove.status, "refused");
  assert.match(hijackApprove.reason ?? "", /only the person who requested/);

  const hijackDeny = await app.turn(
    channel("no, drop it", {
      actor: bystander,
      approval: { requestId: pending.requestId, approved: false },
    }),
  );
  assert.equal(hijackDeny.status, "refused");
  assert.match(hijackDeny.reason ?? "", /only the person who requested/);

  const refusals = (await auditLog.events(tenant)).filter(
    (event) => event.principalId === "U2" && event.status === "refused" && event.action.startsWith("command_approval."),
  );
  assert.equal(refusals.length, 2, "both hijack attempts are audited");
  for (const refusal of refusals) {
    assert.match(refusal.detail ?? "", /not_requester/);
    assert.match(refusal.detail ?? "", /U1/, "the audit names the real requester");
  }

  const approved = await app.turn(
    channel("!collect-approval zz-cmd", {
      approval: { requestId: pending.requestId, approved: true },
    }),
  );
  assert.equal(approved.status, "ok", "the bystander's clicks left the requester's approval intact");
});

test("a pending command in a channel thread doesn't hold up anyone's follow-ups or leak to them", async () => {
  const { app } = await withCommandRules(freshApp());
  const first = await app.turn(channel("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const overheard = await app.turn(channel("what's the hold-up?", { actor: { externalId: "U2" } }));
  assert.equal(overheard.status, "ok");
  assert.equal(overheard.pendingApprovals, undefined, "requestIds and commands never reach a non-requester");

  const nudge = await app.turn(channel("any progress?"));
  assert.equal(nudge.status, "ok");

  const approved = await app.turn(
    channel("!run git push --force origin main", { approval: { requestId: pending.requestId, approved: true } }),
  );
  assert.equal(approved.status, "ok", "the card is still approvable after the follow-ups");
});

test("a session approval covers the whole rule: a different command matching it runs without re-prompting", async () => {
  const { app } = await withCommandRules(freshApp());
  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;
  assert.ok(pending.approvalKey);

  const approved = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true, scope: "session" },
    }),
  );
  assert.equal(approved.status, "ok");

  const sibling = await app.turn(dm("!run git push --force origin release"));
  assert.equal(sibling.status, "ok");
});

test("an admin-registered rule grants by rule across turns; the approval is keyed on its pattern", async () => {
  const { app, config } = freshApp();
  const pattern = "\\bzz-tool\\s+\\S+";
  await config.setCommandPolicy(scopeId("org", "default-org"), {
    mode: "denylist",
    rules: [{ pattern, decision: "require_approval", reason: "ZZ tool" }],
  });

  const first = await app.turn(dm("!run zz-tool alpha"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;
  assert.equal(pending.approvalKey, pattern);

  const approved = await app.turn(
    dm("!run zz-tool alpha", { approval: { requestId: pending.requestId, approved: true, scope: "session" } }),
  );
  assert.equal(approved.status, "ok");

  const sibling = await app.turn(dm("!run zz-tool beta"));
  assert.equal(sibling.status, "ok");
});

test("Dangerous posture keeps predeclared command approvals and hard denials", async () => {
  const { app, config } = freshApp();
  const org = scopeId("org", "default-org");
  await config.setSecurityPosture(org, "dangerous");
  await config.setCommandPolicy(org, {
    mode: "allowlist",
    rules: [
      { pattern: "printf", decision: "require_approval", reason: "test approval" },
      { pattern: "forbidden", decision: "deny", reason: "hard denial" },
    ],
  });

  const gated = await app.turn(dm("!run printf dangerous-gated"));
  assert.equal(gated.status, "pending_approval");
  const pending = gated.pendingApprovals![0]!;
  assert.match(pending.reason, /test approval/);
  const approved = await app.turn(
    dm("!run printf dangerous-gated", { approval: { requestId: pending.requestId, approved: true } }),
  );
  assert.equal(approved.status, "ok");
  assert.match(approved.reply ?? "", /dangerous-gated/);

  const denied = await app.turn(dm("!run forbidden"));
  assert.equal(denied.status, "refused");
  assert.match(denied.reason ?? "", /hard denial/i);
});

test("an admin-removed grant mode is refused, filters the offer, and leaves the approval pending", async () => {
  const { app, config } = await withCommandRules(freshApp());
  const org = scopeId("org", "default-org");
  await config.setApprovalGrantModes(org, { session: false, always: true });

  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;
  assert.deepEqual(pending.grantModes, { session: false, always: true }, "the card is told which buttons it may offer");

  const refused = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true, scope: "session" },
    }),
  );
  assert.equal(refused.status, "pending_approval", "a disabled-mode click re-presents the card instead of settling it");
  assert.match(refused.reason ?? "", /disabled by an admin/);
  assert.equal(
    refused.pendingApprovals?.[0]?.requestId,
    pending.requestId,
    "the SAME approval is re-presented, not a new one",
  );
  assert.deepEqual(
    refused.pendingApprovals?.[0]?.grantModes,
    { session: false, always: true },
    "re-presented with current grant modes so surfaces filter the buttons",
  );

  const once = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true, scope: "once" },
    }),
  );
  assert.equal(once.status, "ok", "the pending approval survives the refused mode and still resolves once");
});

test("a grant mode disabled after an approval was issued is filtered from the re-presented card", async () => {
  const { app, config } = await withCommandRules(freshApp());
  const org = scopeId("org", "default-org");

  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;
  assert.equal(pending.grantModes, undefined, "every mode is on, so the card offers every button");

  await config.setApprovalGrantModes(org, { session: false, always: true });
  const refused = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true, scope: "session" },
    }),
  );
  assert.equal(refused.status, "pending_approval");
  assert.deepEqual(refused.pendingApprovals?.[0]?.grantModes, { session: false, always: true });
});

test("disabling a grant mode suspends existing grants until it is re-enabled", async () => {
  const { app, config } = await withCommandRules(freshApp());
  const org = scopeId("org", "default-org");

  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const done = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: first.pendingApprovals![0]!.requestId, approved: true, scope: "always" },
    }),
  );
  assert.equal(done.status, "ok");
  const covered = await app.turn(dm("!run git push --force origin release"));
  assert.equal(covered.status, "ok", "the standing grant clears the rule while its mode is offered");

  await config.setApprovalGrantModes(org, { session: true, always: false });
  const suspended = await app.turn(dm("!run git push --force origin release"));
  assert.equal(suspended.status, "pending_approval", "an admin-removed mode suspends existing grants of that mode");
  const denied = await app.turn(
    dm("!run git push --force origin release", {
      approval: { requestId: suspended.pendingApprovals![0]!.requestId, approved: false },
    }),
  );
  assert.equal(denied.status, "refused", "clear the parked approval so the next turn isn't waiting on it");

  await config.setApprovalGrantModes(org, { session: true, always: true });
  const restored = await app.turn(dm("!run git push --force origin release"));
  assert.equal(restored.status, "ok", "re-enabling the mode restores the grant without re-approval");
});

test("approving a declared call runs the stored call, not whatever the agent proposes next", async () => {
  const { app, sessions } = freshApp();
  const proposed = { to: "guests@example.com", sends_at: "2026-11-11T12:00:00+08:00" };
  const drifted = { to: "guests@example.com", sends_at: "2026-11-11T04:00:00+00:00" };
  const first = await app.turn(dm(`!declared ${JSON.stringify(proposed)}`));
  assert.equal(first.status, "pending_approval");
  const { requestId } = first.pendingApprovals![0]!;
  assert.equal(first.pendingApprovals![0]!.executesOnApprove, true);

  const approved = await app.turn(
    dm(`!declared ${JSON.stringify(drifted)}`, { approval: { requestId, approved: true } }),
  );
  assert.equal(approved.status, "ok");
  assert.equal(approved.reply, `sent ${JSON.stringify(proposed)}`, "the click ran the exact call the card showed");
  assert.equal(await app.getApproval(requestId), null, "the card is spent");

  const items = await sessions.getItems(approved.sessionId!);
  const ran = items.filter((item) => item.body.approvedRequestId === requestId);
  assert.deepEqual(
    ran.map((item) => item.kind),
    ["ToolCall", "ToolResult"],
    "the approved call is recorded as one call and its result",
  );
});

test("a withdrawn approval card can no longer be approved", async () => {
  const { app } = freshApp();
  const args = { to: "a@example.com", body: "hi" };
  const raised = await app.turn(dm(`!declared-noted ${JSON.stringify(args)}`));
  assert.equal(raised.status, "ok");
  const card = raised.pendingApprovals![0]!;
  assert.equal(card.blocksInput, false, "the person can keep talking while the card waits");
  const cardId = approvalCardId(card.approvalKey!);

  const withdrawn = await app.turn(dm(`!withdraw ${cardId}`));
  assert.equal(withdrawn.reply, "withdrew example_send");
  assert.equal(await app.getApproval(card.requestId), null);

  const late = await app.turn(
    dm(`!declared-noted ${JSON.stringify(args)}`, { approval: { requestId: card.requestId, approved: true } }),
  );
  assert.equal(late.status, "refused", "nothing runs for a withdrawn card");
});

for (const approved of [true, false]) {
  test(`${approved ? "approving" : "denying"} while the requester's next turn runs hands the decision to that run`, async () => {
    const { app, signals } = freshApp();
    const args = { to: "a@example.com", body: approved ? "hi" : "bye" };
    const raised = await app.turn(dm(`!declared-noted ${JSON.stringify(args)}`));
    const { requestId } = raised.pendingApprovals![0]!;
    const hold = `live-${approved}`;
    const holding = app.turn(dm(`!hold ${hold}`));
    let live = mockHeldTurns.get(hold);
    for (let i = 0; !live && i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      live = mockHeldTurns.get(hold);
    }
    assert.ok(live?.resolveSteeredApproval, "the live run exposes the approval hook");
    try {
      const routed = await app.turn(
        dm(`!declared-noted ${JSON.stringify(args)}`, {
          async: true,
          approval: { requestId, approved, ...(approved ? { scope: "once" as const } : {}) },
        }),
      );
      assert.equal(routed.status, "queued");
      assert.equal(routed.steered, true, "the click joins the live run instead of queueing behind it");
      assert.equal(routed.runId, live.runId);

      const delivered = (await signals.pending(live.runId!)).find(({ signal }) => signal.request?.approval);
      assert.ok(delivered, "the decision waits on the live run's signal queue");
      const outcome = await live.resolveSteeredApproval(delivered.signal.request!);
      assert.equal(await app.getApproval(requestId), null, "the card is spent either way");
      if (approved) {
        assert.equal(outcome.kind, "run");
        assert.deepEqual(outcome.kind === "run" ? outcome.call : null, {
          ...(outcome.kind === "run" ? { callId: outcome.call.callId } : {}),
          requestId,
          tool: "example_send",
          input: args,
        });
      } else assert.equal(outcome.kind, "denied");
      assert.equal(
        (await live.resolveSteeredApproval(delivered.signal.request!)).kind,
        "ignored",
        "a second delivery of the same click runs nothing",
      );
      await signals.acknowledge(live.runId!, delivered.id);
    } finally {
      mockHeldTurns.release(hold);
      await holding;
    }
  });
}

test("a tool that declares approval runs once for the exact approved arguments", async () => {
  const { app, sessions } = freshApp();
  const call = '!declared {"to":"a@example.com","body":"hi"}';
  const first = await app.turn(dm(call));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;
  assert.match(pending.approvalKey ?? "", /^tool-call:[0-9a-f]{64}$/);

  const always = await app.turn(
    dm(call, { approval: { requestId: pending.requestId, approved: true, scope: "always" } }),
  );
  assert.equal(always.status, "pending_approval", "a per-call approval offers no standing grant");

  const approved = await app.turn(dm(call, { approval: { requestId: pending.requestId, approved: true } }));
  assert.equal(approved.status, "ok");
  assert.equal(approved.reply, 'sent {"to":"a@example.com","body":"hi"}');

  const again = await app.turn(dm(call));
  assert.equal(again.status, "pending_approval", "the approval was consumed by the one call");
  const changed = await app.turn(dm('!declared {"body":"hi","to":"b@example.com"}'));
  assert.equal(changed.status, "pending_approval", "different arguments need their own approval");

  const denied = await app.turn(
    dm(call, { approval: { requestId: again.pendingApprovals![0]!.requestId, approved: false } }),
  );
  assert.equal(denied.status, "refused");
  const notes = (await sessions.getItems(denied.sessionId!)).filter(
    (item) => item.kind === "UserMessage" && item.hidden,
  );
  assert.ok(
    notes.some((item) => /declined this pending operation, so it did not run: example_send/.test(item.text ?? "")),
  );
});

test("Strict posture gates tool actions behind HiLO and honors a session grant", async () => {
  const built = freshApp();
  await built.config.setSecurityPosture(scopeId("org", "default-org"), "strict");

  const first = await built.app.turn(dm("!write notes.md strict-hello"));
  assert.equal(first.status, "pending_approval", "a plain workspace write pauses under strict");
  const pending = first.pendingApprovals?.[0];
  assert.ok(pending);
  assert.equal(pending!.command, "write");
  assert.equal(pending!.approvalKey, "tool:write");
  assert.match(pending!.reason, /this tool call requires human approval/);

  const approved = await built.app.turn(
    dm("!write notes.md strict-hello", { approval: { requestId: pending!.requestId, approved: true } }),
  );
  assert.equal(approved.status, "ok");
  assert.match(approved.reply ?? "", /wrote notes\.md/);

  const second = await built.app.turn(dm("!write notes.md strict-again"));
  assert.equal(second.status, "pending_approval", "an allow-once grant covers exactly one call");
  const sessionApproved = await built.app.turn(
    dm("!write notes.md strict-again", {
      approval: { requestId: second.pendingApprovals![0]!.requestId, approved: true, scope: "session" },
    }),
  );
  assert.equal(sessionApproved.status, "ok");

  const third = await built.app.turn(dm("!write notes.md strict-covered"));
  assert.equal(third.status, "ok", "a session grant on tool:write clears later write calls without re-prompting");
  assert.match(third.reply ?? "", /wrote notes\.md/);

  const otherTool = await built.app.turn(dm("!read notes.md"));
  assert.equal(otherTool.status, "pending_approval", "the grant covers ONE tool — a different tool still pauses");
  assert.equal(otherTool.pendingApprovals?.[0]?.approvalKey, "tool:read");
});

test("Strict posture layers predeclared command approvals on top of the tool gate", async () => {
  const built = await withCommandRules(freshApp());
  await built.config.setSecurityPosture(scopeId("org", "default-org"), "strict");

  const first = await built.app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const toolPending = first.pendingApprovals![0]!;
  assert.equal(toolPending.approvalKey, "tool:execute", "the strict tool gate fires first");

  const afterToolGrant = await built.app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: toolPending.requestId, approved: true, scope: "session" },
    }),
  );
  assert.equal(
    afterToolGrant.status,
    "pending_approval",
    "the predeclared force-push rule still fires beneath the tool grant",
  );
  const rulePending = afterToolGrant.pendingApprovals![0]!;
  assert.notEqual(rulePending.approvalKey, "tool:execute");
  assert.match(rulePending.reason, /force push/);

  const done = await built.app.turn(
    dm("!run git push --force origin main", { approval: { requestId: rulePending.requestId, approved: true } }),
  );
  assert.equal(done.status, "ok");
});

test("allow once authorizes a single use of the rule, not the rest of the session", async () => {
  const { app, config } = freshApp();
  await config.setCommandPolicy(scopeId("org", "default-org"), {
    mode: "denylist",
    rules: [{ pattern: "\\bzz-tool\\s+\\S+", decision: "require_approval", reason: "ZZ tool" }],
  });

  const first = await app.turn(dm("!run zz-tool alpha"));
  const pending = first.pendingApprovals![0]!;
  await app.turn(
    dm("!run zz-tool alpha", { approval: { requestId: pending.requestId, approved: true, scope: "once" } }),
  );

  const sibling = await app.turn(dm("!run zz-tool beta"));
  assert.equal(sibling.status, "pending_approval");
});

test("approvals collected during an approval re-run are still surfaced (multi-step chains)", async () => {
  const { app } = freshApp();
  const first = await app.turn(dm("!collect-approval cmd-a --danger"));
  assert.equal(first.status, "ok");
  const pendingA = first.pendingApprovals![0]!;

  const second = await app.turn(
    dm("!collect-approval cmd-b --danger", {
      approval: { requestId: pendingA.requestId, approved: true },
    }),
  );
  assert.equal(second.status, "ok");
  const pendingB = second.pendingApprovals?.[0];
  assert.ok(pendingB, "the approval collected during the re-run must not be silently discarded");
  assert.equal(pendingB!.command, "cmd-b --danger");
  assert.ok(pendingB!.requestId, "it carries a requestId so the chain can continue");
});

test("'allow once' authorizes exactly one execution — a sibling approval for the same command stays pending", async () => {
  const { app } = await withCommandRules(freshApp());
  const command = "git push --force origin main";
  const first = await app.turn(dm(`!double-exec ${command}`));
  assert.equal(first.status, "ok");
  assert.match(first.reply ?? "", /ran 0/);
  const pending = first.pendingApprovals![0]!;
  assert.ok(pending);

  const second = await app.turn(
    dm(`!double-exec ${command}`, { approval: { requestId: pending.requestId, approved: true } }),
  );
  assert.equal(second.status, "ok");
  assert.match(second.reply ?? "", /ran 1/, "approving once must run the command once, not both invocations");
  const stillPending = second.pendingApprovals?.[0];
  assert.ok(stillPending, "the second same-command invocation must remain pending, not be auto-approved");
  assert.equal(stillPending!.command, command);
});

test("'allow for session' approves every same-command invocation in the same turn", async () => {
  const { app } = await withCommandRules(freshApp());
  const command = "git push --force origin main";
  const first = await app.turn(dm(`!double-exec ${command}`));
  assert.equal(first.status, "ok");
  const pending = first.pendingApprovals![0]!;

  const second = await app.turn(
    dm(`!double-exec ${command}`, { approval: { requestId: pending.requestId, approved: true, scope: "session" } }),
  );
  assert.equal(second.status, "ok");
  assert.match(second.reply ?? "", /ran 2/, "a session grant approves all invocations of the command");
  assert.equal(second.pendingApprovals?.length ?? 0, 0);
});

test("accepted approval decisions are durably recorded in the conversation", async () => {
  for (const approved of [false, true]) {
    const { app, sessions, runs } = await withCommandRules(freshApp());
    const command = "git push --force origin main";
    const first = await app.turn(dm(`!run ${command}`));
    const requestId = first.pendingApprovals![0]!.requestId;
    await app.turn(dm(`!run ${command}`, { approval: { requestId, approved } }));
    const decisions = (await sessions.getItems(first.sessionId!)).filter((item) => item.kind === "ElicitationResponse");
    assert.equal(decisions.length, 1);
    const replay = (await runs.list()).find((run) => run.request.approval?.requestId === requestId);
    assert.ok(replay);
    const { elicitId, approved: recorded, turnId, body } = decisions[0]!;
    assert.deepEqual(
      { elicitId, approved: recorded, turnId, body },
      { elicitId: requestId, approved, turnId: replay.id, body: { command, ...(approved ? { scope: "once" } : {}) } },
    );
    const live = await app.getRun(replay.id);
    const liveDecisions = live?.activity?.flatMap((entry) =>
      "item" in entry && entry.item.kind === "ElicitationResponse" ? [entry.item] : [],
    );
    assert.equal(liveDecisions?.length, 1);
    const shown = liveDecisions![0]!;
    assert.deepEqual(
      { elicitId: shown.elicitId, approved: shown.approved, turnId: shown.turnId, body: shown.body },
      { elicitId: requestId, approved, turnId: replay.id, body: { command, ...(approved ? { scope: "once" } : {}) } },
    );
  }
});

test("a HiLO approval carries a plain-English summary, persisted durably alongside the static reason", async () => {
  const { app } = await withCommandRules(freshApp());
  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;
  assert.match(pending.summary ?? "", /In plain English: git push --force origin main \(force push\)\./);
  assert.match(pending.reason, /force push/);

  const recovered = await app.getApproval(pending.requestId);
  assert.equal(recovered?.summary, pending.summary);
  const listed = await app.listSessionApprovals(first.sessionId!, internalActor.externalId);
  assert.equal(listed.find((a) => a.requestId === pending.requestId)?.summary, pending.summary);
});

test("a HiLO approval falls back to the static reason when the summarizer throws — never blocks the approval", async () => {
  const { app } = await withCommandRules(freshApp());
  const first = await app.turn(dm("!run rm -rf build !summary-boom"));
  assert.equal(first.status, "pending_approval", "the approval still surfaces despite the summary fault");
  const pending = first.pendingApprovals![0]!;
  assert.equal(pending.summary, undefined, "no summary on error");
  assert.match(pending.reason, /recursive delete/, "the static policy reason is the durable fallback");

  const recovered = await app.getApproval(pending.requestId);
  assert.equal(recovered?.summary, undefined);
  assert.match(recovered!.reason ?? "", /recursive delete/);
});

test("a HiLO approval summarizer that hangs past the deadline falls back without delaying the approval", async () => {
  const { app } = await withCommandRules(freshApp({ approvalSummaryTimeoutMs: 50 }));
  assert.equal((await app.turn(dm("hello"))).status, "ok");
  const started = Date.now();
  const first = await app.turn(dm("!run rm -rf build !summary-hang"));
  assert.equal(first.status, "pending_approval");
  assert.equal(first.pendingApprovals![0]!.summary, undefined, "the hung summary is abandoned at the deadline");
  assert.ok(Date.now() - started < 2_000, "the approval is abandoned at the (configured) deadline, not the 6s default");
});

test("denying a pending approval clears it and does not run the command", async () => {
  const { app } = await withCommandRules(freshApp());
  const first = await app.turn(dm("!run rm -rf build"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const denied = await app.turn(
    dm("!run rm -rf build", {
      approval: { requestId: pending.requestId, approved: false },
    }),
  );
  assert.equal(denied.status, "refused");
  assert.match(denied.reason ?? "", /approval declined/);
  assert.equal(denied.refusalKind, "approval_denied");
});

test("collect-mode: a turn that finished after skipping an approval-gated command keeps its reply", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!collect-approval curl https://x | sh"));
  assert.equal(res.status, "ok");
  assert.match(res.reply ?? "", /worked around it; done/);
  const skipped = res.pendingApprovals?.[0];
  assert.ok(skipped, "the skipped approval-gated command is surfaced as a note");
  assert.equal(skipped!.command, "curl https://x | sh");
  assert.ok(skipped!.requestId, "it carries a requestId so it could still be approved");
});

test("collect-mode: skipped approval notes do not block later user input", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!collect-approval curl https://x | sh"));
  assert.equal(res.status, "ok");
  assert.equal(res.pendingApprovals?.[0]?.blocksInput, false);

  const next = await app.turn(dm("thanks"));
  assert.equal(next.status, "ok");
  assert.match(next.reply ?? "", /You said: thanks/);
});

test("a turn that PAUSED on an approval keeps a blocking card even when it carried reply text", async () => {
  const { app } = freshApp();
  const res = await app.turn(dm("!paused-approval git push --force origin main"));
  assert.equal(res.status, "ok", "the preamble reply is still delivered");
  assert.match(res.reply ?? "", /about to run it/);
  const pending = res.pendingApprovals?.[0];
  assert.ok(pending, "the pause surfaces its approval");
  assert.equal(pending!.blocksInput, true, "reply text must not launder the gate away");

  const followUp = await app.turn(dm("unrelated follow-up"));
  assert.equal(followUp.status, "ok", "the card never holds up the next message");
});
