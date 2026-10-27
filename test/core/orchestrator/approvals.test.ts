import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId, type PendingApprovalRecord } from "../../../src/types.ts";
import { isUserMessage } from "../../../src/sessions/items.ts";
import { freshApp, spyProvisioning, dm, channel, activityItems } from "../../support/orchestrator-app.ts";
import { consumeApprovalDecision, loadApprovalLedger } from "../../../src/core/orchestrator/approvals.ts";

test("an approval pause persists timing on its boundary entry", async () => {
  const { app } = freshApp();
  const before = Date.now();
  const first = await app.turn(dm("!paused-approval git push --force origin main"));
  assert.equal(first.status, "ok");
  assert.ok(first.pendingApprovals?.length);
  const paused = await app.getSession(first.sessionId!);
  const boundary = paused!.items.findLast((entry) => entry.body.blocked === "needs_approval");
  assert.ok(boundary);
  const timing = boundary.body as { workStartedAt: number; workFinishedAt: number };
  assert.ok(timing.workStartedAt >= before);
  assert.ok(timing.workFinishedAt >= timing.workStartedAt);
  assert.ok(timing.workFinishedAt <= boundary.createdAt);
});

test("dangerous command pauses for HiLO approval, then proceeds when approved", async () => {
  const { app } = freshApp();
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
  const userEntries = found!.items.filter((e) => isUserMessage(e));
  assert.equal(userEntries.length, 2, "the approval continuation re-records the turn input");
  const [original, replay] = userEntries as [(typeof userEntries)[0], (typeof userEntries)[0]];
  assert.notEqual(original.hidden, true, "the human's original message stays visible");
  assert.equal(
    replay.hidden,
    true,
    "the continuation's replay is hidden so the chat never shows the human saying it twice",
  );
});

test("a pending command approval blocks unrelated follow-up input in the same thread", async () => {
  const { app } = freshApp();
  const first = await app.turn(dm("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const blocked = await app.turn(dm("actually, what were we doing?"));
  assert.equal(blocked.status, "pending_approval");
  assert.equal(blocked.sessionId, first.sessionId);
  assert.equal(blocked.pendingApprovals?.[0]?.requestId, pending.requestId);

  const found = await app.getSession(first.sessionId!);
  assert.equal(
    found!.items.some((e) => isUserMessage(e) && JSON.stringify(e).includes("what were we doing")),
    false,
    "the blocked follow-up is not appended as a forked user turn",
  );

  const approved = await app.turn(
    dm("!run git push --force origin main", {
      approval: { requestId: pending.requestId, approved: true },
    }),
  );
  assert.equal(approved.status, "ok");
});

test("a second click on an already-consumed approval refuses instead of re-running the command", async () => {
  const { app, auditLog } = freshApp();
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
  const userEntries = found!.items.filter((e) => isUserMessage(e));
  assert.equal(userEntries.length, 2, "the duplicate click never replays the gated command");

  const refusal = (await auditLog.events()).find(
    (event) => event.action === "command_approval.approve" && event.status === "refused",
  );
  assert.match(refusal?.detail ?? "", /expired/, "the refusal is audited as an expired-approval attempt");
});

test("an approval id from another conversation refuses there and stays approvable where it was requested", async () => {
  const { app, auditLog } = freshApp();
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
  const refusal = (await auditLog.events()).find(
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
  const { app, auditLog } = freshApp();
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

  const sealedRefusals = (await auditLog.events()).filter(
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

  const refusals = (await auditLog.events()).filter(
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

test("a pending approval stops blocking its thread once the requester is deactivated", async () => {
  const { app, identity } = freshApp();
  const bystander = { externalId: "U2" };
  const first = await app.turn(channel("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");

  const blocked = await app.turn(
    channel("what's the hold-up?", {
      actor: bystander,
      conversation: { kind: "channel", threadRef: "ch:C1:t1", channelRef: "C1", audience: [bystander] },
    }),
  );
  assert.equal(blocked.status, "pending_approval");

  await identity.deactivate("U1");
  const after = await app.turn(
    channel("hello again?", {
      actor: bystander,
      conversation: { kind: "channel", threadRef: "ch:C1:t1", channelRef: "C1", audience: [bystander] },
    }),
  );
  assert.equal(after.status, "ok", "a departed requester's approval no longer wedges the conversation");

  await identity.reactivate("U1");
  const reactivated = await app.turn(
    channel("still with me?", {
      actor: bystander,
      conversation: { kind: "channel", threadRef: "ch:C1:t1", channelRef: "C1", audience: [bystander] },
    }),
  );
  assert.equal(reactivated.status, "pending_approval", "the returned requester's approval seals the thread again");
  assert.equal(reactivated.pendingApprovals, undefined, "and still reveals nothing to the bystander");

  const resumed = await app.turn(
    channel("!run git push --force origin main", {
      approval: { requestId: first.pendingApprovals![0]!.requestId, approved: true },
    }),
  );
  assert.equal(resumed.status, "ok", "the approval waited for its requester instead of being destroyed");
});

test("a blocked thread hides the requester's pending command from everyone else", async () => {
  const { app } = freshApp();
  const first = await app.turn(channel("!run git push --force origin main"));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const overheard = await app.turn(channel("what's the hold-up?", { actor: { externalId: "U2" } }));
  assert.equal(overheard.status, "pending_approval");
  assert.equal(overheard.pendingApprovals, undefined, "requestIds and commands never reach a non-requester");
  assert.doesNotMatch(overheard.reason ?? "", /git push/);

  const nudge = await app.turn(channel("any progress?"));
  assert.equal(nudge.status, "pending_approval");
  assert.equal(
    nudge.pendingApprovals?.[0]?.requestId,
    pending.requestId,
    "the requester still sees their own pending approval re-presented",
  );
});

test("a session approval covers the whole rule: a different command matching it runs without re-prompting", async () => {
  const { app } = freshApp();
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
  await config.setSetting(
    "commandPolicy",
    {
      mode: "denylist",
      rules: [{ pattern, decision: "require_approval", reason: "ZZ tool" }],
    },
    scopeId("org", "default-org"),
  );

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

test("an admin-removed grant mode is refused, filters the offer, and leaves the approval pending", async () => {
  const { app, config } = freshApp();
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

test("disabling a grant mode suspends existing grants until it is re-enabled", async () => {
  const { app, config } = freshApp();
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
  assert.equal(denied.status, "ok", "clear the parked approval so the next turn isn't waiting on it");

  await config.setApprovalGrantModes(org, { session: true, always: true });
  const restored = await app.turn(dm("!run git push --force origin release"));
  assert.equal(restored.status, "ok", "re-enabling the mode restores the grant without re-approval");
});

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
  assert.equal(denied.status, "ok");
  assert.equal(denied.reply, "carried on without it", "the turn continues past the denial without sending");
  const notes = (await sessions.getItems(denied.sessionId!)).filter((e) => e.kind === "UserMessage" && e.hidden);
  assert.ok(notes.some((e) => /denied this pending operation, so it did not run: example_send/.test(e.text ?? "")));
});

test("an enforced proxy outage fails open and audits the configured provider", async () => {
  const built = freshApp(
    {},
    {
      provider: "example-screen",
      async classify() {
        throw new Error("proxy unavailable");
      },
    },
  );
  const result = await built.app.turn(
    dm("summarize this", {
      surface: "webhook",
      origin: { kind: "automation", screenData: "ordinary external event" },
    }),
  );
  assert.equal(result.status, "ok");
  const event = (await built.auditLog.events()).find(
    (entry) => entry.action === "security_screen.classify" && entry.status === "error",
  );
  assert.equal(event?.resource, "example-screen");
  assert.equal(JSON.parse(event!.detail!).error, "proxy unavailable");
  assert.equal(built.modelGateway.audit().filter((rec) => rec.model === "mock-security").length, 0);
});

test("a thread image is ingested into a session once; later turns that re-send it carry no attachment", async () => {
  const built = freshApp();
  const shot = await built.blobTransfer.put(Buffer.from("png-bytes"));
  const image = (sourceId: string, name: string) => ({
    sourceId,
    name,
    mimetype: "image/png",
    sizeBytes: shot.sizeBytes,
    blobId: shot.blobId,
  });
  const attachmentsOfLastUserEntry = async (sessionId: string) => {
    const users = (await built.sessions.getItems(sessionId)).filter((entry) => isUserMessage(entry));
    return (users.at(-1)!.body as { attachments?: Array<{ sourceId?: string }> }).attachments;
  };

  const first = await built.app.turn(dm("what is this?", { attachments: [image("F-shot", "shot.png")] }));
  assert.equal(first.status, "ok");
  assert.deepEqual(
    (await attachmentsOfLastUserEntry(first.sessionId!))?.map((a) => a.sourceId),
    ["F-shot"],
  );

  const again = await built.app.turn(dm("and now?", { attachments: [image("F-shot", "shot.png")] }));
  assert.equal(again.status, "ok");
  assert.equal(await attachmentsOfLastUserEntry(again.sessionId!), undefined);

  const another = await built.app.turn(
    dm("compare", { attachments: [image("F-shot", "shot.png"), image("F-next", "next.png")] }),
  );
  assert.equal(another.status, "ok");
  assert.deepEqual(
    (await attachmentsOfLastUserEntry(another.sessionId!))?.map((a) => a.sourceId),
    ["F-next"],
  );
});

test("a late proxy verdict after the deadline is never audited as authoritative", async () => {
  let signal: AbortSignal | undefined;
  const built = freshApp(
    { securityScreenTimeoutMs: 5 },
    {
      provider: "example-screen",
      async classify(input) {
        signal = input.signal;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          verdict: { decision: "auto" },
          score: 0.1,
          threshold: 0.7,
        };
      },
    },
  );

  const result = await built.app.turn(
    dm("summarize this", {
      surface: "webhook",
      origin: { kind: "automation", screenData: "ordinary external event" },
    }),
  );
  assert.equal(result.status, "ok");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(signal?.aborted, true);
  const classifications = (await built.auditLog.events()).filter(
    (event) => event.action === "security_screen.classify",
  );
  assert.deepEqual(
    classifications.map((event) => event.status),
    ["error"],
  );
});

test("Auto treats a fresh authenticated ambient speaker as the initiating human", async () => {
  const built = freshApp();
  const provisioning = spyProvisioning(built.sandbox);
  const result = await built.app.turn(channel("!run printf ambient-ok", { origin: { kind: "ambient" } }));
  assert.equal(result.status, "ok");
  assert.match(result.reply ?? "", /ambient-ok/);
  assert.equal(provisioning.provisioned, 1);
  assert.equal(
    built.modelGateway.audit().some((call) => call.model === "mock-security"),
    false,
  );
});

test("allow once authorizes a single use of the rule, not the rest of the session", async () => {
  const { app, config } = freshApp();
  await config.setSetting(
    "commandPolicy",
    {
      mode: "denylist",
      rules: [{ pattern: "\\bzz-tool\\s+\\S+", decision: "require_approval", reason: "ZZ tool" }],
    },
    scopeId("org", "default-org"),
  );

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
  const { app } = freshApp();
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
  const { app } = freshApp();
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
    const { app, sessions, runs } = freshApp();
    const command = "git push --force origin main";
    const first = await app.turn(dm(`!run ${command}`));
    const requestId = first.pendingApprovals![0]!.requestId;
    await app.turn(dm(`!run ${command}`, { approval: { requestId, approved } }));
    const decisions = (await sessions.getItems(first.sessionId!)).filter(
      (entry) => entry.kind === "ElicitationResponse",
    );
    assert.equal(decisions.length, 1);
    const replay = (await runs.list()).find((run) => run.request.approval?.requestId === requestId);
    assert.ok(replay);
    const decision = decisions[0]!;
    const { approvalKey, ...body } = decision.body;
    assert.deepEqual(
      { elicitId: decision.elicitId, approved: decision.approved, turnId: decision.turnId, body },
      { elicitId: requestId, approved, turnId: replay.id, body: { command, ...(approved ? { scope: "once" } : {}) } },
    );
    assert.equal(typeof approvalKey, approved ? "string" : "undefined");
    const live = await app.getRun(replay.id);
    const liveDecisions = activityItems(live?.activity).filter((item) => item.kind === "ElicitationResponse");
    assert.equal(liveDecisions.length, 1);
    assert.deepEqual(liveDecisions[0], decision);
  }
});

test("'session busy' does not consume the one-shot approval (a retry click still works)", async () => {
  const { app, sessions } = freshApp();
  const command = "git push --force origin main";
  const first = await app.turn(dm(`!run ${command}`));
  assert.equal(first.status, "pending_approval");
  const pending = first.pendingApprovals![0]!;

  const { lease } = await sessions.acquireLease(first.sessionId!);
  assert.ok(lease, "hold the session lease so the approval turn lands on a busy session");
  const busy = await app.turn(dm(`!run ${command}`, { approval: { requestId: pending.requestId, approved: true } }));
  assert.equal(busy.status, "refused");
  assert.equal(busy.refusalKind, "session_busy");
  await sessions.releaseLease(lease!);

  const retried = await app.turn(dm(`!run ${command}`, { approval: { requestId: pending.requestId, approved: true } }));
  assert.equal(retried.status, "ok", retried.reason);
});

test("'session busy' does not consume an idempotency key (a retried fire with the same key runs)", async () => {
  const { app, sessions } = freshApp();
  const first = await app.turn(dm("hello there"));
  assert.equal(first.status, "ok");

  const { lease } = await sessions.acquireLease(first.sessionId!);
  assert.ok(lease, "hold the session lease so the keyed turn lands on a busy session");
  const busy = await app.turn(dm("remind me", { idempotencyKey: "cron:c1:1000" }));
  assert.equal(busy.status, "refused");
  assert.equal(busy.refusalKind, "session_busy");
  await sessions.releaseLease(lease!);

  const retried = await app.turn(dm("remind me", { idempotencyKey: "cron:c1:1000" }));
  assert.equal(retried.status, "ok", retried.reason);
});

function harness(records: Array<[string, PendingApprovalRecord]>, history: Array<Record<string, unknown>> = []) {
  const pending = new Map(records);
  const grants = new Map<string, unknown>();
  const appended: Array<Record<string, unknown>> = [];
  const deps = {
    approvals: {
      get: async (id: string) => pending.get(id) ?? null,
      delete: async (id: string) => void pending.delete(id),
      take: async (id: string) => {
        const value = pending.get(id) ?? null;
        pending.delete(id);
        return value;
      },
    },
    approvalGrants: { put: async (id: string, grant: unknown) => void grants.set(id, grant) },
    auditLog: { record: () => {} },
    sessions: {
      getItems: async (_sessionId: string, opts: { turnId?: string }) =>
        history.filter((item) => item.turnId === opts.turnId),
      appendMany: async (_lease: unknown, items: Array<Record<string, unknown>>) => {
        appended.push(...items);
        return items;
      },
    },
  };
  const ledger = loadApprovalLedger([], "S1", { session: true, always: true });
  const decide = (
    decision: { requestId: string; approved: boolean; scope?: "once" | "session" | "always" },
    runId?: string,
  ) =>
    consumeApprovalDecision({
      deps: deps as never,
      decision,
      sessionId: "S1",
      ...(runId ? { runId } : {}),
      lease: {} as never,
      actorId: "U1",
      scopeId: "org" as never,
      resolution: { approvalGrantModes: { session: true, always: true } },
      ledger,
      withRosterVersion: (fn) => fn(),
      mirror: async () => {},
    });
  return { pending, grants, appended, ledger, decide };
}

const request = { sessionId: "S1", command: "git push --force", request: { actor: { externalId: "U1" } } as never };

test("two simultaneous approvals of one request credit the command once", async () => {
  const h = harness([["R1", request]]);
  const outcomes = await Promise.all([
    h.decide({ requestId: "R1", approved: true }),
    h.decide({ requestId: "R1", approved: true }),
  ]);
  assert.deepEqual(outcomes.map((o) => o.kind).sort(), ["approved", "settled"]);
  assert.equal(h.ledger.consume("git push --force"), true);
  assert.equal(h.ledger.consume("git push --force"), false);
});

test("a retried run recovers an approval its first attempt recorded before crashing", async () => {
  const h = harness(
    [],
    [
      {
        kind: "ElicitationResponse",
        turnId: "run-1",
        elicitId: "R1",
        approved: true,
        body: { command: "git push --force", scope: "session" },
      },
    ],
  );
  const outcome = await h.decide({ requestId: "R1", approved: true, scope: "session" }, "run-1");
  assert.equal(outcome.kind, "approved");
  assert.equal(h.appended.length, 0);
  assert.equal(h.ledger.consume("git push --force"), true);
  assert.equal(h.grants.size, 1);
});

test("a recorded denial stays a denial on retry", async () => {
  const h = harness(
    [["R1", request]],
    [
      {
        kind: "ElicitationResponse",
        turnId: "run-1",
        elicitId: "R1",
        approved: false,
        body: { command: "git push --force" },
      },
    ],
  );
  const outcome = await h.decide({ requestId: "R1", approved: false }, "run-1");
  assert.equal(outcome.kind, "denied");
  assert.equal(h.pending.size, 0);
  assert.equal(h.ledger.consume("git push --force"), false);
});
