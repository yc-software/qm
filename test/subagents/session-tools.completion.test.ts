import { wireRunResultPosts, runResultPost } from "../../src/runs/run-results.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import { createControlService } from "../../src/api/control-service.ts";
import { deliveryCandidatesFor } from "../../src/core/orchestrator/turn-helpers.ts";
import { createSessionMailbox } from "../../src/sessions/session-mailbox.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunSignalStore } from "../../src/runs/run-signal-store.ts";
import { createSessionSyscalls } from "../../src/subagents/session-tools.ts";
import { deliverSubagentMail } from "../../src/subagents/mail.ts";
import { delegatedAuthorizationOrigin } from "../../src/subagents/delegation.ts";
import { sessionTreeRunCount, stopSessionTree } from "../../src/subagents/tree.ts";
import type { Run } from "../../src/runs/run-store.ts";
import { scopeId, type Conversation, type Principal, type ScopeId, type Session } from "../../src/types.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";
import { claimTurn, completeTurn, finishTurn } from "../support/turns.ts";
import {
  actor,
  scope,
  conversation,
  runStore,
  rig,
  freshSession,
  delegatedHumanRig,
  closeRigStores,
} from "../support/subagent-rig.ts";

after(closeRigStores);

test("completed children do not fill a working parent's run slots and consumed returns settle", async () => {
  const r = await rig();
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "slack", origin: { kind: "human" }, text: "work" },
  });
  await claimTurn(r.ledger, parent.run.id);
  const deps = { ...r, maxAttempts: 3, delegationEnabled: async () => true };
  const pending: Run[] = [];
  for (let i = 0; i < 12; i++) {
    const opened = await r.syscallsFor(r.room).open({ task: `work ${i}` });
    assert.ok(opened.ok);
    const child = await freshSession(r.sessions, opened.sessionId);
    const [run] = await r.runs.inFlightForThread(child.threadRef);
    await completeTurn(r.ledger, run!.id, { status: "ok", reply: `result ${i}` });
    const finished = (await r.runs.get(run!.id))!;
    assert.equal(await deliverSubagentMail(deps, finished), false);
    assert.equal(await sessionTreeRunCount(r.sessions, r.runs, r.room), 2, "the working parent and one shared wake");
    pending.push(finished);
  }
  let received = 0;
  while (received < 12) {
    const messages = await r.syscallsFor(r.room).receive!();
    assert.ok(messages.length > 0);
    received += messages.length;
    await r.syscallsFor(r.room).acknowledge!(messages.map((message) => message.id));
  }
  assert.equal(received, 12);
  for (const run of pending) {
    assert.equal(await deliverSubagentMail(deps, run), true);
    await r.runs.markReturned(run.id);
  }
  assert.deepEqual(await r.runs.pendingReturns(), []);
  assert.equal(await sessionTreeRunCount(r.sessions, r.runs, r.room), 1);
});

test("unread completions survive parent shutdown and share one pending wakeup", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3, delegationEnabled: async () => true };
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "slack", origin: { kind: "human" }, text: "work" },
  });
  const active = await claimTurn(r.ledger, parent.run.id);
  assert.deepEqual(await r.syscallsFor(r.room).receive!(), []);
  for (let i = 0; i < 3; i++) {
    const opened = await r.syscallsFor(r.room).open({ task: `late result ${i}` });
    assert.ok(opened.ok);
    const child = await freshSession(r.sessions, opened.sessionId);
    const [run] = await r.runs.inFlightForThread(child.threadRef);
    await completeTurn(r.ledger, run!.id, { status: "ok", reply: `late ${i}` });
    assert.equal(await deliverSubagentMail(deps, (await r.runs.get(run!.id))!), false);
  }
  await finishTurn(active!, { status: "silent" });
  for (const run of await r.runs.pendingReturns()) assert.equal(await deliverSubagentMail(deps, run), false);
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1);
  const wake = await claimTurn(r.ledger, wakes[0]!.id);
  const mail = await r.syscallsFor(r.room).receive!();
  assert.equal(mail.length, 3);
  await r.syscallsFor(r.room).acknowledge!(mail.map((message) => message.id));
  for (const run of await r.runs.pendingReturns()) {
    assert.equal(await deliverSubagentMail(deps, run), true);
    await r.runs.markReturned(run.id);
  }
  assert.equal((await r.runs.get(wake!.run.id))!.status, "running");
  await finishTurn(wake!, { status: "silent" });
  assert.deepEqual(await r.runs.pendingReturns(), []);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
});

test("legacy returned children with consumed mail release queued wakeups without cancelling user work", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3, delegationEnabled: async () => true };
  const opened = await r.syscallsFor(r.room).open({ task: "old completion" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  await completeTurn(r.ledger, run!.id, { status: "ok", reply: "done" });
  const finished = (await r.runs.get(run!.id))!;
  assert.equal(await deliverSubagentMail(deps, finished), false);
  await r.runs.markReturned(finished.id);
  await r.runs.deferReturn(finished.id, 0);
  const user = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, origin: { kind: "human" }, text: "new user work" },
  });
  await r.mailbox.acknowledge(r.room.id, [`subagent-mail-${finished.id}`]);
  assert.deepEqual(
    (await r.runs.pendingReturns()).map((pending) => pending.id),
    [finished.id],
  );
  assert.equal(await deliverSubagentMail(deps, finished), true);
  await r.runs.markReturned(finished.id);
  assert.deepEqual(await r.runs.pendingReturns(), []);
  assert.deepEqual(
    (await r.runs.inFlightForThread(r.room.threadRef)).map((pending) => pending.id),
    [user.run.id],
  );
});

test("a completion wake that consumed mail and then retries retains its turn and delegation authority", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3, delegationEnabled: async () => true };
  const opened = await r.syscallsFor(r.room).open({ task: "finish" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  await completeTurn(r.ledger, run!.id, { status: "ok", reply: "done" });
  const finished = (await r.runs.get(run!.id))!;
  await deliverSubagentMail(deps, finished);
  const wake = (await r.runs.inFlightForThread(r.room.threadRef))[0]!;
  const running = await claimTurn(r.ledger, wake.id);
  await r.mailbox.acknowledge(r.room.id, [`subagent-mail-${finished.id}`]);
  await r.ledger.handBack(running!.run, running!.token, { delayMs: 1000, countsAsError: true });
  assert.equal(await deliverSubagentMail(deps, finished), true);
  await r.runs.markReturned(finished.id);
  assert.equal((await r.runs.get(wake.id))!.status, "pending");
  assert.equal((await r.runs.get(wake.id))!.attempts, 1);
  assert.deepEqual(await r.runs.pendingReturns(), []);
});

for (const addressed of [true, false]) {
  test(`completion inherits request context without replaying its turn, addressed=${addressed}`, async () => {
    const inherited = {
      addressed,
      surfaceTools: false,
      deliveryTarget: "slack:D1:task",
      deliveryCandidates: [{ target: "slack:D1:task", label: "Original conversation" }],
      gatewayContext: { location: "original DM", details: { channel: "D1" }, instructions: "Reply in Slack" },
      timezone: "America/Los_Angeles",
      model: "test-model",
      thinkingLevel: "high",
      fastMode: false,
      skipMemory: true,
      turnWallClockMs: 120000,
      analyticsSuppressed: true,
    };
    const transient: Partial<OrchestratorInput> = {
      runId: "old-run",
      attempt: 3,
      runLeaseToken: "old-lease",
      runStartedAt: 10,
      finalAttempt: true,
      approval: { requestId: "old-approval", approved: true },
      redeliveryKey: "old-envelope",
      proactiveOpener: true,
      attachments: [{ name: "old.txt", mimetype: "text/plain", sizeBytes: 1, blobId: "old-blob" }],
      inboundNotes: ["old input"],
      priorTurns: [],
      overheard: [],
      detectContext: "old detection",
      detectOpener: "old opener",
      conversationHeader: "old header",
    };
    const r = await delegatedHumanRig({ ...inherited, ...transient });
    await completeTurn(r.ledger, r.parent.id, { status: "silent" });
    await completeTurn(r.ledger, r.run.id, { status: "ok", reply: "verified result" });
    const result = (await r.runs.get(r.run.id))!;
    await deliverSubagentMail({ ...r, maxAttempts: 3, delegationEnabled: async () => true }, result);
    const wake = (await r.runs.getByDedupKey(`subagent-return:${r.run.id}`))!;
    assert.ok(wake);
    for (const [key, value] of Object.entries(inherited)) {
      if (key === "surfaceTools") continue;
      assert.deepEqual(wake.request[key as keyof OrchestratorInput], value, key);
    }
    for (const key of Object.keys(transient))
      assert.equal(wake.request[key as keyof OrchestratorInput], undefined, key);
    assert.equal(wake.request.surfaceTools, true);
    assert.equal(wake.request.delegatingRunId, r.parent.id);
    assert.equal(wake.request.sessionSenderId, r.child.id);
    assert.equal(wake.request.origin.kind, "human");
    assert.match(wake.request.text, /New internal messages arrived/);
    assert.equal(wake.request.displayText, "Delegated task completed");
    assert.equal(wake.request.envelopeWrapped, true);
  });
}

test("nested delegated work retains the reminder destination without exposing surface tools", async () => {
  const r = await rig();
  const first = await r.syscallsFor(r.room).open({ task: "analyze and remind me" });
  assert.ok(first.ok);
  const child = await freshSession(r.sessions, first.sessionId);
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
  const second = await factory
    .forTurn({ session: child, scopeId: scope, request: { ...run.request, runId: run.id } })
    .open({ task: "schedule the result" });
  assert.ok(second.ok);
  const grandchild = await freshSession(r.sessions, second.sessionId);
  const request = (await r.runs.inFlightForThread(grandchild.threadRef))[0]!.request;
  assert.equal(request.surfaceTools, undefined);
  const destinations = deliveryCandidatesFor(
    request.surface,
    request.deliveryTarget,
    request.deliveryCandidates,
    scope,
  );
  const control = createControlService({
    isOpenScopeMember: async () => false,
    createCron: async (input: unknown) => ({ id: "reminder", ...(input as object) }),
  } as never);
  const reminder = await control.createCron(
    { schedule: { firstFireAt: Date.now() + 60_000 }, text: "the result" },
    {
      actorId: actor.id,
      scopeId: scope,
      exp: Date.now() + 60_000,
      destinations: destinations.candidates,
      defaultDestinationKey: destinations.defaultKey,
    },
  );
  assert.ok(reminder.ok);
  assert.equal(reminder.cron.destination?.target, "D1");
});

for (const status of ["ok", "pending_approval"] as const) {
  test(`child ${status} forwards files once without creating approval outbound`, async () => {
    const r = await rig();
    const outbound = recordingOutbound();
    const out = await r.syscallsFor(r.room).open({ task: "prepare the report" });
    assert.ok(out.ok);
    const child = await freshSession(r.sessions, out.sessionId);
    const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
    const attachment = { name: "report.pdf", blobId: "report", mimetype: "application/pdf", sizeBytes: 42 };
    await completeTurn(r.ledger, run.id, {
      status,
      attachments: [attachment],
      pendingApprovals: [{ requestId: "approve-report", command: "publish", reason: "needs consent" }],
    });
    const completed = (await r.runs.get(run.id))!;
    const deps = { ...r, maxAttempts: 3, outbound };
    await deliverSubagentMail(deps, completed);
    await deliverSubagentMail(deps, completed);
    const files = await outbound.pending("slack");
    assert.equal(files.length, 1);
    assert.deepEqual(files[0]!.attachments, [attachment]);
    assert.equal(files[0]!.destination.target, "D1");
    const approvals = await outbound.pending("principal");
    assert.equal(approvals.length, 0);
    assert.match((await r.mailbox.pending(r.room.id))[0]!.text, /awaiting_input/);
  });
}

test("file-only child completion is a result", async () => {
  const r = await rig();
  const outbound = recordingOutbound();
  const out = await r.syscallsFor(r.room).open({ task: "make a chart" });
  assert.ok(out.ok);
  const child = await freshSession(r.sessions, out.sessionId);
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await completeTurn(r.ledger, run.id, {
    status: "ok",
    attachments: [{ name: "chart.png", blobId: "chart", mimetype: "image/png", sizeBytes: 1 }],
  });
  await deliverSubagentMail({ ...r, maxAttempts: 3, outbound }, (await r.runs.get(run.id))!);
  assert.match((await r.mailbox.pending(r.room.id))[0]!.text, /Produced chart.png/);
});

test("stopping an idle coordinator cancels running and queued descendants and blocks new work", async () => {
  const r = await rig();
  const out = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(out.ok);
  const child = await freshSession(r.sessions, out.sessionId);
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await claimTurn(r.ledger, run.id);
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
  const childApi = factory.forTurn({ session: child, scopeId: scope, request: { ...run.request, runId: run.id } });
  const grandchild = await childApi.open({ task: "more work" });
  assert.ok(grandchild.ok);
  assert.equal(await stopSessionTree(r, r.room), true);
  assert.equal(
    (await r.runs.inFlightForThread((await freshSession(r.sessions, grandchild.sessionId)).threadRef)).length,
    0,
  );
  assert.equal((await r.signals.pending(run.id))[0]!.signal.kind, "abort");
  const late = await childApi.open({ task: "late spawn" });
  assert.equal(late.ok, false);
  const followup = await childApi.write({ target: grandchild.sessionId, followup: true, text: "late followup" });
  assert.equal(followup.ok, false);
  await finishTurn(claimed!, { status: "ok", reply: "late result" });
  assert.equal(
    await deliverSubagentMail(
      { ...r, maxAttempts: 3, delegationEnabled: async () => true },
      (await r.runs.get(run.id))!,
    ),
    true,
  );
  assert.equal((await r.mailbox.pending(r.room.id)).length, 0);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);
});

for (const surface of ["slack", "web"] as const) {
  for (const nested of [false, true]) {
    test(`${surface}: ${nested ? "nested child" : "child"} results stay internal while files and parent replies deliver once`, async () => {
      const r = await rig();
      const outbound = recordingOutbound();
      wireRunResultPosts(r.runs, outbound, { graceMs: 0 });
      const request: OrchestratorInput = {
        surface,
        actor,
        conversation,
        deliveryTarget: "D1",
        origin: { kind: "direct" },
        text: "research this",
      };
      const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
      const open = async (parent: Session) => {
        const parentRequest = (await r.runs.inFlightForThread(parent.threadRef))[0]?.request ?? request;
        const out = await factory
          .forTurn({ session: parent, scopeId: scope, request: parentRequest })
          .open({ task: "research privately" });
        assert.ok(out.ok);
        return freshSession(r.sessions, out.sessionId);
      };
      const parent = nested ? await open(r.room) : r.room;
      const child = await open(parent);
      const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
      assert.equal(queued.request.deliveryTarget, "D1");
      const first = await claimTurn(r.ledger, queued.id);
      await r.ledger.handBack(first!.run, first!.token, { countsAsError: true });
      const attachment = { name: "report.txt", blobId: "report", mimetype: "text/plain", sizeBytes: 42 };
      await completeTurn(r.ledger, queued.id, {
        status: "ok",
        reply: "INTERNAL_CHILD_REPORT: suggested answer for parent",
        attachments: [attachment],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        await outbound.pending(surface),
        [],
        "terminal listener must not publish child results or files",
      );
      const completed = (await r.runs.get(queued.id))!;
      assert.equal(
        runResultPost(JSON.parse(JSON.stringify(completed))),
        null,
        "serialized terminal runs remain internal",
      );
      const deps = { ...r, maxAttempts: 3, outbound };
      await deliverSubagentMail(deps, completed);
      await deliverSubagentMail(deps, completed);
      const mail = await r.mailbox.pending(parent.id);
      assert.equal(mail.length, 1);
      assert.match(mail[0]!.text, /INTERNAL_CHILD_REPORT/);
      await r.mailbox.acknowledge(parent.id, [mail[0]!.id]);
      await deliverSubagentMail(deps, completed);
      const files = await outbound.pending(surface);
      assert.equal(files.length, 1);
      assert.equal(files[0]!.text, "");
      assert.deepEqual(files[0]!.attachments, [attachment]);
      assert.equal(files[0]!.destination.target, "D1");
      const parentRun = (await r.runs.enqueue({ sessionId: r.room.threadRef, request })).run;
      await completeTurn(r.ledger, parentRun.id, { status: "ok", reply: "PUBLIC_PARENT_ANSWER" });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const publicResults = await outbound.pending(surface);
      assert.deepEqual(publicResults.map((item) => item.text).filter(Boolean), ["PUBLIC_PARENT_ANSWER"]);
      assert.equal(publicResults.filter((item) => item.attachments?.length).length, 1);
    });
  }
}

test("children of a Slack group turn keep its source so external-workspace policy admits them", async () => {
  const { externalSlackRequestAllowed } = await import("../../src/resolution/external-slack.ts");
  const { externalSlackNamespace } = await import("../../src/slack/external-access.ts");
  const access = { companyDomains: ["partner.example"], companyTeamIds: ["TCOMPANY"], serviceCredentials: ["search"] };
  const policies = { ext: access };
  const admitted = (request: OrchestratorInput) =>
    externalSlackRequestAllowed({ ...request, surface: request.surface ?? "" }, policies);
  const { runs, databaseUrl } = runStore();
  const sessions = createPostgresSessionStore(databaseUrl);
  const factory = createSessionSyscalls({
    mailbox: createSessionMailbox(testDatabaseUrl()),
    sessions,
    runs,
    signals: createMemoryRunSignalStore(),
    advisoryLock: testAdvisoryLock(),
    maxAttempts: 3,
  });
  const cases = [
    {
      threadRef: "slack:group:G1",
      request: { slackSource: { accountId: "staff", teamId: "T1", userId: "U1" } },
    },
    {
      threadRef: `${externalSlackNamespace("T2", access)}:C2`,
      request: { externalSlack: { accountId: "ext", teamId: "T2", userId: "U1", ...access } },
    },
  ];
  for (const c of cases) {
    const group: Conversation = { kind: "group", threadRef: c.threadRef, channelRef: c.threadRef, audience: [actor] };
    const room = await sessions.getOrCreateByThread(c.threadRef, "group", scope, undefined, "slack");
    await sessions.addParticipant(room.id, actor.id);
    const syscalls = factory.forTurn({
      session: room,
      scopeId: scope,
      request: { surface: "slack", conversation: group, actor, ...c.request },
    });
    const opened = await syscalls.open({ task: "look into it" });
    assert.ok(opened.ok);
    const child = await freshSession(sessions, opened.sessionId);
    const [run] = await runs.inFlightForThread(child.threadRef);
    assert.ok(admitted(run!.request));
    assert.deepEqual(run!.request.externalSlack, "externalSlack" in c.request ? c.request.externalSlack : undefined);
    const followed = await syscalls.write({ target: child.id, text: "more", followup: true });
    assert.ok(followed.ok, JSON.stringify(followed));
    const latest = (await runs.inFlightForThread(child.threadRef)).at(-1)!;
    assert.ok(admitted(latest.request));
    assert.deepEqual(latest.request.externalSlack, run!.request.externalSlack);
  }
});

test("sessions list shows only sidebar sessions the whole audience can see and create needs a live turn", async () => {
  const { runs, databaseUrl } = runStore();
  const sessions = createPostgresSessionStore(databaseUrl);
  const started: Array<{ forkOf?: string; text?: string; title?: string; scopeId: ScopeId }> = [];
  const room = await sessions.getOrCreateByThread("web:U1:room", "dm", scope, undefined, "web");
  await sessions.updateTitle(room.id, "room");
  const peer = await sessions.getOrCreateByThread("web:U1:peer", "dm", scope, undefined, "web");
  await sessions.updateTitle(peer.id, "peer");
  const archived = await sessions.getOrCreateByThread("web:U1:old", "dm", scope, undefined, "web");
  const elsewhere = await sessions.getOrCreateByThread("web:U1:other", "channel", scopeId("channel", "C9"));
  for (const s of [room, peer, archived, elsewhere]) await sessions.addParticipant(s.id, actor.id);
  const guest: Principal = { id: "G1", type: "guest", displayName: "Guest" };
  await sessions.addParticipant(room.id, guest.id);
  const factory = createSessionSyscalls({
    mailbox: createSessionMailbox(testDatabaseUrl()),
    sessions,
    runs,
    signals: createMemoryRunSignalStore(),
    advisoryLock: testAdvisoryLock(),
    maxAttempts: 3,
    conversations: {
      list: async () => [
        (await sessions.get(room.id))!,
        (await sessions.get(peer.id))!,
        { ...(await sessions.get(archived.id))!, archived: true },
        (await sessions.get(elsewhere.id))!,
        {
          ...(await sessions.get(peer.id))!,
          id: "child",
          threadRef: "agent:main:subagent:x",
          parentSessionId: room.id,
        },
      ],
      start: async (_actorId, input) => {
        started.push(input);
        return { session: { ...(await sessions.get(peer.id))!, id: "made", title: "made" } };
      },
    },
  });
  const forTurn = (
    liveTurn: boolean,
    opts: { readOnly?: boolean; audience?: Principal[]; surface?: string; memory?: string } = {},
  ) =>
    factory.forTurn({
      session: room,
      scopeId: scope,
      liveTurn,
      ...(opts.memory ? { memoryContext: { audience: opts.memory } } : {}),
      request: {
        surface: opts.surface ?? "web",
        conversation: { kind: "dm", threadRef: room.threadRef, audience: opts.audience ?? [actor] },
        actor,
        origin: { kind: "human" },
        ...(opts.readOnly ? { readOnly: true } : {}),
      } as Parameters<typeof factory.forTurn>[0]["request"],
    });
  const live = forTurn(true);
  const listed = await live.list!();
  assert.ok(listed.ok);
  assert.deepEqual(listed.sessions.map((s) => [s.title, s.current]).sort(), [
    ["peer", false],
    ["room", true],
  ]);
  const shared = await forTurn(false, { audience: [actor, guest] }).list!();
  assert.ok(shared.ok);
  assert.deepEqual(
    shared.sessions.map((s) => s.title),
    ["room"],
  );
  assert.deepEqual(await live.start!({ fork: false }), {
    ok: false,
    message: "new requires `text`: the new session's first message.",
  });
  assert.equal((await live.start!({ fork: false, text: "hello", title: "fresh" })).ok, true);
  assert.equal((await live.start!({ fork: true })).ok, true);
  assert.deepEqual(started, [
    { scopeId: scope, origin: { kind: "human" }, sessionSenderId: room.id, text: "hello", title: "fresh" },
    { scopeId: scope, origin: { kind: "human" }, sessionSenderId: room.id, forkOf: room.id },
  ]);
  const child = await sessions.getOrCreateByThread("agent:main:subagent:w", "dm", scope, undefined, "web");
  await sessions.updateTitle(child.id, "worker");
  await sessions.addParticipant(child.id, actor.id);
  await sessions.setParentSession(child.id, room.id);
  for (const out of [
    await live.read({ peer: true, target: child.id }),
    await live.write({ peer: true, target: child.id, text: "hi" }),
  ])
    assert.deepEqual(out, {
      ok: false,
      message: '"worker" is a subagent, not a session — use the subagents tool for it.',
    });
  const fromChild = factory.forTurn({
    session: child,
    scopeId: scope,
    liveTurn: true,
    request: {
      surface: "web",
      conversation: { kind: "dm", threadRef: child.threadRef, audience: [actor] },
      actor,
      origin: { kind: "human" },
    } as Parameters<typeof factory.forTurn>[0]["request"],
  });
  for (const out of [await fromChild.list!(), await fromChild.start!({ fork: true })])
    assert.equal(out.ok, true, JSON.stringify(out));
  const slack = forTurn(true, { surface: "slack" });
  for (const out of [
    await slack.list!(),
    await slack.start!({ fork: true }),
    await slack.read({ peer: true, target: peer.id }),
  ])
    assert.deepEqual(out, { ok: false, message: "sessions are a web UI feature and aren't available here." });
  for (const blocked of [forTurn(false), forTurn(true, { readOnly: true })]) {
    const out = await blocked.start!({ fork: true });
    assert.equal(out.ok, false);
  }
  assert.equal(started.length, 3);
});

test("stopping a session tree tells every stopped run who stopped it", async () => {
  const sent: Array<{ runId: string; signal: unknown }> = [];
  const root = { id: "root", scopeId: "personal:a", threadRef: "web:root" } as unknown as Session;
  const child = { id: "child", scopeId: "personal:a", threadRef: "agent:main:subagent:child" } as unknown as Session;
  const stopped = await stopSessionTree(
    {
      sessions: { descendantsOf: async () => [{ ...child, rootId: root.id }] },
      runs: {
        inFlightForThread: async (threadRef: string) =>
          [{ id: `run-${threadRef}`, status: "running" }] as unknown as Run[],
        cancelTree: async () => 0,
      },
      signals: {
        send: async (runId: string, signal: unknown) => {
          sent.push({ runId, signal });
          return true;
        },
      },
    },
    root,
    "by the parent agent",
  );
  assert.equal(stopped, true);
  assert.deepEqual(
    sent.map((s) => s.signal),
    [
      { kind: "abort", reason: "by the parent agent" },
      { kind: "abort", reason: "by the parent agent" },
    ],
  );
});

for (const origin of [
  { kind: "human", messageTs: "1", entryTs: "2" },
  { kind: "ambient", live: true, entryTs: "2" },
  { kind: "automation" },
] as const) {
  test(`nested tasks and followups inherit ${origin.kind} origin`, async () => {
    const r = await delegatedHumanRig({ origin });
    const childApi = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
      session: r.child,
      scopeId: scope,
      request: { ...r.run.request, runId: r.run.id },
    });
    const opened = await childApi.open({ task: "inspect nested" });
    assert.ok(opened.ok);
    const child = (await r.sessions.get(opened.sessionId))!;
    const nested = (await r.runs.latestForThread(child.threadRef))!;
    assert.equal(nested.request.origin.kind, origin.kind);
    assert.equal("messageTs" in nested.request.origin, false);
    assert.equal("entryTs" in nested.request.origin, false);
    assert.equal(nested.request.delegatingRunId, r.run.id);
    assert.equal(nested.request.sessionSenderId, r.child.id);
    assert.ok((await childApi.write({ target: child.id, followup: true, text: "inspect again" })).ok);
    const followup = (await r.runs.latestForThread(child.threadRef))!;
    assert.equal(followup.request.origin.kind, origin.kind);
    assert.equal(followup.request.delegatingRunId, r.run.id);
  });
}

test("detaching an ancestor revokes a descendant's delegated live authority", async () => {
  const r = await delegatedHumanRig();
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.child,
    scopeId: scope,
    request: { ...r.run.request, runId: r.run.id },
  });
  const opened = await api.open({ task: "inspect nested" });
  assert.ok(opened.ok);
  const nested = (await r.sessions.get(opened.sessionId))!;
  const run = (await r.runs.latestForThread(nested.threadRef))!;
  assert.equal((await delegatedAuthorizationOrigin(run.request, r))?.kind, "human");
  await r.sessions.setParentSession(r.child.id, null);
  assert.equal(await delegatedAuthorizationOrigin(run.request, r), undefined);
});
