import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createSessionSyscalls } from "../../src/subagents/session-tools.ts";
import { deliverSubagentMail, renderSubagentMail } from "../../src/subagents/mail.ts";
import { SUBAGENT_TREE_RUN_CAP } from "../../src/subagents/tree.ts";
import { isSubagentThreadRef } from "../../src/sessions/thread-ref.ts";
import { scopeId } from "../../src/types.ts";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import { claimTurn, completeTurn, finishTurn } from "../support/turns.ts";
import { actor, scope, conversation, rig, freshSession, closeRigStores } from "../support/subagent-rig.ts";

after(closeRigStores);

test("open creates a child session with parent pointer, spawn meta, and a queued task run", async () => {
  const r = await rig();
  const out = await r.syscallsFor(r.room).open({ task: "build a personal website for alex", name: "website" });
  assert.ok(out.ok);
  const child = await freshSession(r.sessions, out.sessionId);
  assert.equal(child.parentSessionId, r.room.id);
  assert.equal(child.title, "website");
  assert.ok(isSubagentThreadRef(child.threadRef));
  assert.equal(child.spawnMeta?.deliveryTarget, "D1");
  assert.equal(child.spawnMeta?.surface, "slack");
  const inFlight = await r.runs.inFlightForThread(child.threadRef);
  assert.equal(inFlight.length, 1);
  const request = inFlight[0]!.request;
  assert.equal(request.conversation.threadRef, child.threadRef);
  assert.equal(request.deliveryTarget, "D1");
  assert.match(request.text, /subagent-task/);
  assert.match(request.text, /build a personal website/);
  assert.equal(out.liveRunsRemaining, SUBAGENT_TREE_RUN_CAP - 1);
});

for (const explicit of [
  {},
  { fastMode: false },
  { model: "chosen-model", thinkingLevel: "high", fastMode: false },
  { model: "chosen-model", fastMode: true },
]) {
  test(`child followups preserve only explicit runtime choices: ${JSON.stringify(explicit)}`, async () => {
    const runtimeKeys = ["model", "thinkingLevel", "fastMode"] as const;
    let defaults = { model: "old-default", thinkingLevel: "low", fastMode: true };
    const preparedInputs: OrchestratorInput[] = [];
    const r = await rig({
      prepareRequest: async (request) => {
        preparedInputs.push(request);
        return { ...defaults, ...request };
      },
    });
    const syscalls = r.syscallsFor(r.room);
    const opened = await syscalls.open({ task: "initial task", ...explicit });
    assert.ok(opened.ok);
    const child = await freshSession(r.sessions, opened.sessionId);
    const first = (await r.runs.inFlightForThread(child.threadRef))[0]!;
    for (const key of runtimeKeys) {
      assert.equal(child.spawnMeta?.[key], explicit[key as keyof typeof explicit]);
      assert.equal(Object.hasOwn(child.spawnMeta!, key), Object.hasOwn(explicit, key));
      assert.equal(first.request[key], { ...defaults, ...explicit }[key]);
    }
    await completeTurn(r.ledger, first.id, { status: "ok", reply: "done" });
    defaults = { model: "new-default", thinkingLevel: "medium", fastMode: false };
    const followup = await syscalls.write({ followup: true, target: child.id, text: "next task" });
    assert.ok(followup.ok);
    assert.equal(followup.delivered, "queued_turn");
    const next = (await r.runs.inFlightForThread(child.threadRef))[0]!;
    for (const key of runtimeKeys) {
      assert.equal(Object.hasOwn(preparedInputs[1]!, key), Object.hasOwn(explicit, key));
      assert.equal(next.request[key], { ...defaults, ...explicit }[key]);
    }
    assert.equal((await freshSession(r.sessions, child.id)).parentSessionId, r.room.id);
  });
}

test("empty writes name the action and field the caller used", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const followup = await r.syscallsFor(r.room).write({ followup: true, target: opened.sessionId });
  assert.ok(!followup.ok);
  assert.match(followup.message, /^followup_task requires `task`/);
  const message = await r.syscallsFor(r.room).write({ target: opened.sessionId, text: "  " });
  assert.ok(!message.ok);
  assert.match(message.message, /^send_message requires `text`/);
  const self = await r.syscallsFor(r.room).write({ target: r.room.id, text: "hi" });
  assert.ok(!self.ok);
  assert.match(self.message, /cannot message itself/);
});

test("followup tasks cannot turn an ordinary session into a child", async () => {
  const r = await rig();
  const ordinary = await r.sessions.getOrCreateByThread("web:ordinary", "dm", scope, undefined, "web");
  await r.sessions.addParticipant(ordinary.id, actor.id);
  await r.runs.enqueue({
    sessionId: ordinary.threadRef,
    request: { actor, conversation, surface: "web", origin: { kind: "human" }, text: "hello" },
  });
  const out = await r.syscallsFor(r.room).write({ followup: true, target: ordinary.id, text: "new task" });
  assert.ok(!out.ok);
  assert.match(out.message, /only target an attached subagent/);
  assert.equal((await freshSession(r.sessions, ordinary.id)).parentSessionId, undefined);
  assert.equal((await r.runs.inFlightForThread(ordinary.threadRef)).length, 1);
});

test("nested sessions share the same tree without an artificial depth limit", async () => {
  const r = await rig();
  const first = await r.syscallsFor(r.room).open({ task: "level one" });
  assert.ok(first.ok);
  const child = await freshSession(r.sessions, first.sessionId);
  const second = await r.syscallsFor(child).open({ task: "level two" });
  assert.ok(second.ok);
  const grandchild = await freshSession(r.sessions, second.sessionId);
  const third = await r.syscallsFor(grandchild).open({ task: "level three" });
  assert.ok(third.ok);
});

test("open refuses when the tree's live-run slots are used up", async () => {
  const r = await rig({ treeRunCap: 1 });
  const first = await r.syscallsFor(r.room).open({ task: "one" });
  assert.ok(first.ok);
  const second = await r.syscallsFor(r.room).open({ task: "two" });
  assert.ok(!second.ok);
  assert.match(second.message, /slots/);
});

test("write queues separately from a running child and interrupts explicitly", async () => {
  const r = await rig();
  const syscalls = r.syscallsFor(r.room);
  const opened = await syscalls.open({ task: "watch the deploy", name: "watch_deploy" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await claimTurn(r.ledger, queued.id);
  assert.ok(claimed);

  const steered = await syscalls.write({ followup: true, target: opened.sessionId, text: "focus on the canary" });
  assert.ok(steered.ok);
  assert.equal(steered.delivered, "queued_turn");
  const pending = await r.signals.takePending(queued.id);
  assert.equal(pending.length, 0);
  const followup = (await r.runs.inFlightForThread(child.threadRef)).find((run) => run.id !== queued.id)!;
  assert.equal(followup.request.origin.kind, "automation");
  assert.match(followup.request.text, /focus on the canary/);

  const interrupted = await syscalls.write({ target: opened.sessionId, interrupt: true });
  assert.ok(interrupted.ok);
  assert.equal(interrupted.delivered, "interrupted");
  assert.equal((await r.signals.takePending(queued.id))[0]!.kind, "abort");

  await finishTurn(claimed, { status: "ok", reply: "done" });
  const retask = await syscalls.write({ followup: true, target: "watch_deploy", text: "check it again" });
  assert.ok(retask.ok);
  assert.equal(retask.delivered, "queued_turn");
  const rerun = await r.runs.inFlightForThread(child.threadRef);
  assert.equal(rerun.length, 1);
  assert.ok(rerun.some((run) => /check it again/.test(run.request.text)));
});

test("write refuses self, cross-scope, and nonparticipant targets", async () => {
  const r = await rig();
  const syscalls = r.syscallsFor(r.room);
  const self = await syscalls.write({ target: r.room.id, text: "hi" });
  assert.ok(!self.ok);
  const other = await r.sessions.getOrCreateByThread(
    "slack:dm:D2",
    "dm",
    scopeId("personal", "U2"),
    undefined,
    "slack",
  );
  const cross = await syscalls.write({ target: other.id, text: "hi" });
  assert.ok(!cross.ok);
  const sameScopeRoom = await r.sessions.getOrCreateByThread("web:U1:x", "dm", scope, undefined, "web");
  const nonSubagent = await syscalls.write({ target: sameScopeRoom.id, text: "hi" });
  assert.ok(!nonSubagent.ok);
  assert.match(nonSubagent.message, /participant/);
});

test("read lists children with status and renders a child's recent transcript", async () => {
  const r = await rig();
  const syscalls = r.syscallsFor(r.room);
  const opened = await syscalls.open({ task: "research callers", name: "research_callers" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const { lease } = await r.sessions.acquireLease(child.id, "turn");
  assert.ok(lease);
  await r.sessions.append(lease!, { kind: "AgentMessage", text: "found 3 call sites" });
  await r.sessions.releaseLease(lease!);

  const list = await syscalls.read({});
  assert.ok(list.ok && list.mode === "children");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0]!.title, "research_callers");
  assert.equal(list.children[0]!.status, "pending");
  assert.match(list.children[0]!.lastSaid ?? "", /3 call sites/);

  const transcript = await syscalls.read({ target: "research_callers" });
  assert.ok(transcript.ok && transcript.mode === "transcript");
  assert.match(transcript.rendered, /found 3 call sites/);
});

test("a finished child durably wakes its Slack parent exactly once and leaves the result in its mailbox", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "summarize the logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await completeTurn(r.ledger, queued.id, { status: "ok", reply: "logs are clean" });
  const finished = await r.runs.get(queued.id);

  await deliverSubagentMail(
    { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
    finished!,
  );
  const mail = await r.mailbox.pending(r.room.id);
  assert.equal(mail.length, 1);
  const request = mail[0]!;
  assert.equal(request.recipientId, r.room.id);
  assert.match(request.text, /<wake reason="subagent"/);
  assert.match(request.text, /kind="final_answer"/);
  assert.match(request.text, /logs are clean/);

  await deliverSubagentMail(
    { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
    finished!,
  );
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.dedupKey, `subagent-return:${finished!.id}`);
  assert.match(wakes[0]!.request.text, /Call subagents read with no target/);
  assert.equal(wakes[0]!.request.surfaceTools, true);
});

test("children finishing while a parent is busy share one queued wake", async () => {
  const r = await rig();
  const finished = [];
  for (const task of ["first", "second", "third"]) {
    const opened = await r.syscallsFor(r.room).open({ task, requestId: task });
    assert.ok(opened.ok);
    const child = await freshSession(r.sessions, opened.sessionId);
    const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
    await completeTurn(r.ledger, queued.id, { status: "ok", reply: `${task} done` });
    finished.push((await r.runs.get(queued.id))!);
  }
  const busy = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { ...finished[0]!.request, text: "busy" },
  });
  for (const run of finished) {
    const settled = await deliverSubagentMail(
      { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
      run,
    );
    assert.equal(settled, false, "a return stays open until the parent reads its mail");
  }
  assert.equal((await r.mailbox.pending(r.room.id)).length, 3);
  const wakes = (await r.runs.inFlightForThread(r.room.threadRef)).filter((run) => run.id !== busy.run.id);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.request.wakeCause, "child_done");
});

test("a silent child mails a completed-without-reply notice without borrowing transcript text", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "quiet work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const { lease } = await r.sessions.acquireLease(child.id, "turn");
  await r.sessions.append(lease!, { kind: "AgentMessage", text: "halfway there" });
  await r.sessions.releaseLease(lease!);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await completeTurn(r.ledger, queued.id, { status: "silent" });
  const finished = await r.runs.get(queued.id);

  await deliverSubagentMail(
    { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
    finished!,
  );
  const mail = await r.mailbox.pending(r.room.id);
  assert.equal(mail.length, 1);
  assert.match(mail[0]!.text, /kind="no_reply"/);
  assert.doesNotMatch(mail[0]!.text, /halfway there/);
});

test("a detached child sends no mail; any in-scope session can still be read", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "detachable work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  await r.sessions.setParentSession(child.id, null);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await completeTurn(r.ledger, queued.id, { status: "ok", reply: "done alone" });
  const finished = await r.runs.get(queued.id);

  await deliverSubagentMail(
    { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
    finished!,
  );
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);

  const read = await r.syscallsFor(r.room).read({ target: child.id });
  assert.ok(read.ok && read.mode === "transcript");
});

test("mail envelope attributes stay well-formed and machine-parseable when the title holds quotes", () => {
  const mail = renderSubagentMail({
    title: 'Poet "one" <b>',
    sessionId: "child-1",
    kind: "final_answer",
    body: "the poem",
  });
  const head = /^<wake reason="subagent" name="([^"]*)" sessionId="([^"]*)" kind="([^"]*)"/.exec(mail);
  assert.ok(head, "the first line matches the shape the web transcript parses");
  assert.equal(head[1], "Poet &quot;one&quot; &lt;b&gt;");
  assert.equal(head[2], "child-1");
  assert.equal(head[3], "final_answer");
});

test("concurrent opens and re-tasking share one admission limit", async () => {
  const r = await rig({ treeRunCap: 1 });
  const opened = await Promise.all([
    r.syscallsFor(r.room).open({ task: "one" }),
    r.syscallsFor(r.room).open({ task: "two" }),
  ]);
  assert.equal(opened.filter((out) => out.ok).length, 1);
  const first = opened.find((out) => out.ok)!;
  assert.ok(first.ok);
  const child = await freshSession(r.sessions, first.sessionId);
  const [queued] = await r.runs.inFlightForThread(child.threadRef);
  await completeTurn(r.ledger, queued!.id, { status: "ok", reply: "done" });
  const second = await r.syscallsFor(r.room).open({ task: "another" });
  assert.ok(second.ok);
  const rewritten = await r.syscallsFor(r.room).write({ followup: true, target: child.id, text: "again" });
  assert.equal(rewritten.ok, false);
});

test("session reads hide history outside the viewer's participant tenure", async () => {
  const r = await rig();
  const target = await r.sessions.getOrCreateByThread("web:private-old", "dm", scope);
  const { lease } = await r.sessions.acquireLease(target.id);
  assert.ok(lease);
  await r.sessions.append(lease, { kind: "AgentMessage", text: "hidden-before-membership" });
  await r.sessions.releaseLease(lease);
  await r.sessions.addParticipant(target.id, actor.id);
  const view = await r.syscallsFor(r.room).read({ target: target.id });
  assert.ok(view.ok && view.mode === "transcript");
  assert.doesNotMatch(view.rendered, /hidden-before-membership/);
});

test("child runs retain the managed roster and read-only floor", async () => {
  const r = await rig();
  const tool = createSessionSyscalls({
    ...r,
    maxAttempts: 3,
  }).forTurn({
    session: r.room,
    scopeId: scope,
    request: {
      surface: "web",
      actor,
      conversation,
      readOnly: true,
      scopeVersion: "roster-version",
      sessionParticipantIds: [actor.id],
    },
  });
  const out = await tool.open({ task: "inspect", readOnly: false });
  assert.ok(out.ok);
  const child = await freshSession(r.sessions, out.sessionId);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  assert.equal(run!.request.readOnly, true);
  assert.equal(run!.request.scopeVersion, "roster-version");
  assert.deepEqual(run!.request.sessionParticipantIds, [actor.id]);
});

test("terminal children remain recoverable until their return is acknowledged", async () => {
  const r = await rig();
  const out = await r.syscallsFor(r.room).open({ task: "finish" });
  assert.ok(out.ok);
  const child = await freshSession(r.sessions, out.sessionId);
  const [queued] = await r.runs.inFlightForThread(child.threadRef);
  await completeTurn(r.ledger, queued!.id, { status: "ok", reply: "done" });
  const [pending] = await r.runs.pendingReturns();
  assert.equal(pending!.id, queued!.id);
  let failed = false;
  await assert.rejects(
    deliverSubagentMail(
      {
        sessions: r.sessions,
        maxAttempts: 3,
        runs: r.runs,
        mailbox: {
          ...r.mailbox,
          send: async () => {
            failed = true;
            throw new Error("database unavailable");
          },
        },
      },
      pending!,
    ),
  );
  assert.equal(failed, true);
  assert.equal((await r.runs.pendingReturns()).length, 1);
  await deliverSubagentMail(
    { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
    pending!,
  );
  await deliverSubagentMail(
    { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
    pending!,
  );
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.dedupKey, `subagent-return:${pending!.id}`);
  assert.match(wakes[0]!.request.text, /Call subagents read with no target/);
  assert.equal(wakes[0]!.request.surfaceTools, true);
  await r.mailbox.acknowledge(r.room.id, [`subagent-mail-${pending!.id}`]);
  assert.equal(
    await deliverSubagentMail(
      { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
      pending!,
    ),
    true,
  );
  await r.runs.markReturned(pending!.id);
  assert.deepEqual(await r.runs.pendingReturns(), []);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
});

test("adopting into a fresh web parent never delivers to the old parent's surface", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const destination = await r.sessions.getOrCreateByThread("web:U1:new-parent", "dm", scope, undefined, "slack");
  await r.sessions.setParentSession(child.id, destination.id);
  const [queued] = await r.runs.inFlightForThread(child.threadRef);
  await completeTurn(r.ledger, queued!.id, { status: "ok", reply: "ready" });
  const finished = (await r.runs.get(queued!.id))!;
  await assert.rejects(
    deliverSubagentMail(
      { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
      finished,
    ),
    /verified runtime context/,
  );
  await r.runs.enqueue({
    sessionId: destination.threadRef,
    request: {
      actor,
      conversation: { ...conversation, threadRef: destination.threadRef },
      origin: { kind: "direct" },
      surface: "web",
      deliveryTarget: destination.threadRef,
      text: "hello",
    },
  });
  await deliverSubagentMail(
    { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
    finished,
  );
  const [mail] = await r.mailbox.pending(destination.id);
  assert.equal(mail!.recipientId, destination.id);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 0);
});

test("return pagination reaches later children while earlier returns remain blocked", async () => {
  const r = await rig();
  for (let i = 0; i < 105; i++) {
    const { run } = await r.runs.enqueue({
      sessionId: `agent:main:subagent:pending-${i}`,
      maxAttempts: 3,
      request: { actor, conversation, text: "finish", origin: { kind: "direct" } },
    });
    await completeTurn(r.ledger, run.id, { status: "ok", reply: "done" });
  }
  const first = await r.runs.pendingReturns(100);
  const next = await r.runs.pendingReturns(100, first.at(-1)!.id);
  assert.equal(first.length, 100);
  assert.equal(next.length, 5);
  assert.equal(new Set([...first, ...next].map((run) => run.id)).size, 105);
  assert.equal((await r.runs.pendingReturns(100, next.at(-1)!.id)).length, 0);
});

test("ordinary-session messages queue privately without steering an externally delivering turn", async () => {
  const r = await rig();
  const target = await r.sessions.getOrCreateByThread("web:U1:peer", "dm", scope);
  await r.sessions.addParticipant(target.id, actor.id);
  const { run } = await r.runs.enqueue({
    sessionId: target.threadRef,
    request: {
      actor,
      conversation: { ...conversation, threadRef: target.threadRef },
      origin: { kind: "direct" },
      surface: "slack",
      deliveryTarget: "D-other",
      deliveryCandidates: [{ target: "D-other", label: "DM" }],
      surfaceTools: true,
      text: "original task",
    },
  });
  await claimTurn(r.ledger, run.id);
  const result = await r.syscallsFor(r.room).write({ target: target.id, text: "an intermediate update" });
  assert.ok(result.ok);
  assert.equal(result.delivered, "queued_message");
  assert.deepEqual(await r.signals.takePending(run.id), []);
  assert.equal((await r.runs.inFlightForThread(target.threadRef)).length, 1);
  const [mail] = await r.mailbox.pending(target.id);
  assert.match(mail!.text, /an intermediate update/);
  assert.equal((await r.syscallsFor(r.room).write({ target: target.id, text: "wake", followup: true })).ok, false);
});

test("read-only callers cannot steer writable children and preserve the floor when queuing", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  const claimed = await claimTurn(r.ledger, run!.id);
  const api = createSessionSyscalls({
    ...r,
    maxAttempts: 3,
  }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, readOnly: true },
  });
  const refused = await api.write({ followup: true, target: child.id, text: "change things" });
  assert.ok(refused.ok);
  assert.deepEqual(await r.signals.takePending(run!.id), []);
  await finishTurn(claimed!, { status: "ok", reply: "finished" });
  const queued = await api.write({ followup: true, target: child.id, text: "inspect only" });
  assert.ok(queued.ok);
  assert.equal((await r.runs.inFlightForThread(child.threadRef))[0]!.request.readOnly, true);
});

test("writes revalidate access even while a target is running", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  await claimTurn(r.ledger, run!.id);
  const api = createSessionSyscalls({
    ...r,
    maxAttempts: 3,
    authorize: async (session) => session.id !== child.id,
  }).forTurn({ session: r.room, scopeId: scope, request: { actor, conversation } });
  assert.equal((await api.write({ target: child.id, text: "hello" })).ok, false);
  assert.deepEqual(await r.signals.takePending(run!.id), []);
});

test("completion cannot expand the finished run's audience and retries after its return delay", async (t) => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "private research" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  await completeTurn(r.ledger, run!.id, { status: "ok", reply: "private result" });
  let expanded = true;
  let attempts = 0;
  const recover = async () => {
    for (const pending of await r.runs.pendingReturns()) {
      attempts++;
      try {
        if (
          await deliverSubagentMail(
            {
              mailbox: r.mailbox,
              sessions: r.sessions,
              runs: r.runs,
              maxAttempts: 3,
              prepareRequest: async (request) => ({
                ...request,
                conversation: {
                  ...request.conversation,
                  audience: expanded ? [actor, { id: "new-member", type: "internal" }] : [actor],
                },
              }),
            },
            pending,
          )
        )
          await r.runs.markReturned(pending.id);
      } catch (error) {
        await r.runs.deferReturn(pending.id, 60_000);
        throw error;
      }
    }
  };
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await assert.rejects(recover(), /audience/);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
  assert.deepEqual(await r.mailbox.pending(r.room.id), []);
  expanded = false;
  for (let i = 0; i < 59; i++) {
    t.mock.timers.tick(1_000);
    await recover();
  }
  assert.equal(attempts, 1);
  t.mock.timers.tick(1_000);
  await recover();
  assert.equal(attempts, 2);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
  assert.ok(await r.runs.getByDedupKey(`subagent-return:${run!.id}`));
});
