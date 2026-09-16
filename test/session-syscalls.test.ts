import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSessionMailbox, type SessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import {
  createSessionSyscalls,
  deliverSubagentMail,
  isSubagentThreadRef,
  renderSubagentMail,
  SUBAGENT_TREE_RUN_CAP,
} from "../src/sessions/session-syscalls.ts";
import { scopeId, type Conversation, type Principal, type ScopeId, type Session } from "../src/types.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { RunStore } from "../src/runs/run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

const actor: Principal = { id: "U1", type: "internal", displayName: "Alex" };
const scope: ScopeId = scopeId("personal", "U1");
const conversation: Conversation = { kind: "dm", threadRef: "slack:dm:D1", audience: [actor] };

interface Rig {
  mailbox: SessionMailbox;
  sessions: SessionStore;
  runs: RunStore;
  signals: ReturnType<typeof createMemoryRunSignalStore>;
  room: Session;
  syscallsFor(session: Session): ReturnType<ReturnType<typeof createSessionSyscalls>["forTurn"]>;
}

async function rig(opts?: { treeRunCap?: number }): Promise<Rig> {
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const signals = createMemoryRunSignalStore();
  const mailbox = createSessionMailbox(createMemoryMap<SessionMessage>());
  const factory = createSessionSyscalls({
    mailbox,
    sessions,
    runs,
    signals,
    maxAttempts: 3,
    ...(opts?.treeRunCap !== undefined ? { treeRunCap: opts.treeRunCap } : {}),
  });
  const room = await sessions.getOrCreateByThread("slack:dm:D1", "dm", scope, undefined, "slack");
  await sessions.updateTitle(room.id, "dm with alex");
  await sessions.addParticipant(room.id, actor.id);
  const binding = (session: Session) => ({
    session,
    scopeId: scope,
    request: {
      surface: "slack",
      conversation,
      actor,
      deliveryTarget: "D1",
      timezone: "America/Los_Angeles",
    } as Pick<OrchestratorInput, "surface" | "conversation" | "actor" | "deliveryTarget" | "timezone" | "readOnly">,
  });
  return {
    mailbox,
    sessions,
    runs,
    signals,
    room,
    syscallsFor: (session) => factory.forTurn(binding(session)),
  };
}

async function freshSession(sessions: SessionStore, id: string): Promise<Session> {
  const s = await sessions.get(id);
  assert.ok(s);
  return s;
}

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
  assert.equal(request.deliveryTarget, undefined);
  assert.match(request.text, /subagent-task/);
  assert.match(request.text, /build a personal website/);
  assert.equal(out.liveRunsRemaining, SUBAGENT_TREE_RUN_CAP - 1);
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
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
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

  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const retask = await syscalls.write({ followup: true, target: "watch_deploy", text: "check it again" });
  assert.ok(retask.ok);
  assert.equal(retask.delivered, "queued_turn");
  const rerun = await r.runs.inFlightForThread(child.threadRef);
  assert.equal(rerun.length, 2);
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

test("read lists children with status and renders a child's recent tape", async () => {
  const r = await rig();
  const syscalls = r.syscallsFor(r.room);
  const opened = await syscalls.open({ task: "research callers", name: "research_callers" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const { lease } = await r.sessions.acquireLease(child.id, "turn");
  assert.ok(lease);
  await r.sessions.append(lease!, { type: "assistant", payload: { text: "found 3 call sites" }, scopeLabel: scope });
  await r.sessions.releaseLease(lease!);

  const list = await syscalls.read({});
  assert.ok(list.ok && list.mode === "children");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0]!.title, "research_callers");
  assert.equal(list.children[0]!.status, "pending");
  assert.match(list.children[0]!.lastSaid ?? "", /3 call sites/);

  const tape = await syscalls.read({ target: "research_callers" });
  assert.ok(tape.ok && tape.mode === "tape");
  assert.match(tape.rendered, /found 3 call sites/);
});

test("a finished child's final answer is mailed to the parent without starting a parent run", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "summarize the logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "logs are clean" });
  const finished = await r.runs.get(queued.id);

  await deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, finished!);
  const mail = await r.mailbox.pending(r.room.id);
  assert.equal(mail.length, 1);
  const request = mail[0]!;
  assert.equal(request.recipientId, r.room.id);
  assert.match(request.text, /<wake reason="subagent"/);
  assert.match(request.text, /kind="final_answer"/);
  assert.match(request.text, /logs are clean/);

  await deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, finished!);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);
});

test("a silent child mails a completed-without-reply notice without borrowing transcript text", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "quiet work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const { lease } = await r.sessions.acquireLease(child.id, "turn");
  await r.sessions.append(lease!, { type: "assistant", payload: { text: "halfway there" }, scopeLabel: scope });
  await r.sessions.releaseLease(lease!);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "silent" });
  const finished = await r.runs.get(queued.id);

  await deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, finished!);
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
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done alone" });
  const finished = await r.runs.get(queued.id);

  await deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, finished!);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);

  const read = await r.syscallsFor(r.room).read({ target: child.id });
  assert.ok(read.ok && read.mode === "tape");
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
  const claimed = await r.runs.claimById(queued!.id, "worker", 30_000);
  await r.runs.complete(queued!.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
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
  await r.sessions.append(lease, {
    type: "assistant",
    payload: { text: "hidden-before-membership" },
    scopeLabel: scope,
  });
  await r.sessions.releaseLease(lease);
  await r.sessions.addParticipant(target.id, actor.id);
  const view = await r.syscallsFor(r.room).read({ target: target.id });
  assert.ok(view.ok && view.mode === "tape");
  assert.doesNotMatch(view.rendered, /hidden-before-membership/);
});

test("shared session reads require every audience member to see each entry", async () => {
  const r = await rig();
  const other: Principal = { id: "U2", type: "internal" };
  const sharedScope = scopeId("group", "G1");
  const shared = await r.sessions.getOrCreateByThread("group:G1", "group", sharedScope);
  await r.sessions.addParticipant(shared.id, actor.id);
  await r.sessions.addParticipant(shared.id, other.id);
  const { lease } = await r.sessions.acquireLease(shared.id);
  assert.ok(lease);
  await r.sessions.append(lease, { type: "assistant", payload: { text: "private-only" }, scopeLabel: scope });
  await r.sessions.append(lease, { type: "assistant", payload: { text: "shared-visible" }, scopeLabel: sharedScope });
  await r.sessions.releaseLease(lease);
  const factory = createSessionSyscalls({
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
    maxAttempts: 3,
  });
  const tool = factory.forTurn({
    session: shared,
    scopeId: sharedScope,
    orgScopeId: scopeId("org", "example"),
    request: {
      surface: "web",
      actor,
      conversation: { kind: "group", threadRef: shared.threadRef, audience: [actor, other] },
    },
  });
  const view = await tool.read({ target: shared.id });
  assert.ok(view.ok && view.mode === "tape");
  assert.doesNotMatch(view.rendered, /private-only/);
  assert.match(view.rendered, /shared-visible/);
});

test("child runs retain the managed roster and read-only floor", async () => {
  const r = await rig();
  const tool = createSessionSyscalls({
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
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
  const claimed = await r.runs.claimById(queued!.id, "worker", 30_000);
  await r.runs.complete(queued!.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
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
  await deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, pending!);
  await deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, pending!);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);
  await r.runs.markReturned(pending!.id);
  assert.deepEqual(await r.runs.pendingReturns(), []);
});

test("adopting into a fresh web parent never delivers to the old parent's surface", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const destination = await r.sessions.getOrCreateByThread("web:U1:new-parent", "dm", scope, undefined, "slack");
  await r.sessions.setParentSession(child.id, destination.id);
  const [queued] = await r.runs.inFlightForThread(child.threadRef);
  const claimed = await r.runs.claimById(queued!.id, "worker", 30_000);
  await r.runs.complete(queued!.id, claimed!.leaseToken!, { status: "ok", reply: "ready" });
  const finished = (await r.runs.get(queued!.id))!;
  await assert.rejects(
    deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, finished),
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
  await deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, finished);
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
    const claimed = await r.runs.claimById(run.id, "worker", 30_000);
    await r.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
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
  await r.runs.claimById(run.id, "worker", 60_000);
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
  const claimed = await r.runs.claimById(run!.id, "worker", 60_000);
  const api = createSessionSyscalls({
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
    maxAttempts: 3,
  }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, readOnly: true },
  });
  const refused = await api.write({ followup: true, target: child.id, text: "change things" });
  assert.ok(refused.ok);
  assert.deepEqual(await r.signals.takePending(run!.id), []);
  await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: "finished" });
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
  await r.runs.claimById(run!.id, "worker", 60_000);
  const api = createSessionSyscalls({
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
    maxAttempts: 3,
    authorize: async (session) => session.id !== child.id,
  }).forTurn({ session: r.room, scopeId: scope, request: { actor, conversation } });
  assert.equal((await api.write({ target: child.id, text: "hello" })).ok, false);
  assert.deepEqual(await r.signals.takePending(run!.id), []);
});

test("completion cannot expand the finished run's audience during roster refresh", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "private research" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  const claimed = await r.runs.claimById(run!.id, "worker", 60_000);
  await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: "private result" });
  await assert.rejects(
    deliverSubagentMail(
      {
        mailbox: r.mailbox,
        sessions: r.sessions,
        runs: r.runs,
        maxAttempts: 3,
        prepareRequest: async (request) => ({
          ...request,
          conversation: { ...request.conversation, audience: [actor, { id: "new-member", type: "internal" }] },
        }),
      },
      (await r.runs.get(run!.id))!,
    ),
    /audience/,
  );
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
  assert.equal((await r.runs.pendingReturns()).length, 1);
});

test("private session replies stay read-only, queue behind running work, and do not return to a parent", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const initial = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.equal(initial.request.origin.kind, "automation");
  await r.runs.claimById(initial.id, "worker", 30_000);
  const factory = createSessionSyscalls({
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
    maxAttempts: 3,
  });
  const privateCaller = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, readOnly: true, privateSessionMessage: true, sessionMessageDepth: 1 },
  });
  assert.equal((await privateCaller.open({ task: "escape" })).ok, false);
  assert.equal((await privateCaller.write({ target: child.id, interrupt: true })).ok, false);
  const sent = await privateCaller.write({ target: child.id, text: "Here is the answer" });
  assert.ok(sent.ok);
  assert.equal(sent.delivered, "queued_message");
  assert.equal((await r.signals.takePending(initial.id)).length, 0);
  assert.equal((await r.runs.inFlightForThread(child.threadRef)).length, 1);
  assert.equal((await r.mailbox.pending(child.id)).length, 1);
  assert.equal((await privateCaller.write({ target: child.id, text: "wake", followup: true })).ok, false);
  const exhausted = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, readOnly: true, privateSessionMessage: true, sessionMessageDepth: 8 },
  });
  assert.equal((await exhausted.write({ target: child.id, text: "loop" })).ok, false);
});

test("session tools cannot bypass swarm worker admission or message budgets", async () => {
  const r = await rig();
  const worker = await r.sessions.getOrCreateByThread("swarm:root:worker", "dm", scope);
  await r.sessions.addParticipant(worker.id, actor.id);
  assert.equal((await r.syscallsFor(worker).open({ task: "escape" })).ok, false);
  assert.equal((await r.syscallsFor(worker).write({ target: r.room.id, text: "escape" })).ok, false);
  assert.equal((await r.syscallsFor(r.room).write({ target: worker.id, text: "escape" })).ok, false);
  const factory = createSessionSyscalls({
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
    maxAttempts: 3,
  });
  const rootNotification = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, swarm: { swarmId: "root", messageId: "message", recipientId: "root" } },
  });
  assert.equal((await rootNotification.open({ task: "escape" })).ok, false);
});

test("retrying open after an uncertain enqueue recovers one child and rejects a changed request", async (t) => {
  const r = await rig();
  const enqueue = r.runs.enqueue.bind(r.runs);
  let loseReceipt = true;
  t.mock.method(r.runs, "enqueue", async (input: Parameters<RunStore["enqueue"]>[0]) => {
    const result = await enqueue(input);
    if (loseReceipt) {
      loseReceipt = false;
      throw new Error("lost receipt");
    }
    return result;
  });
  const input = { task: "one delegation", requestId: "stable-call" };
  assert.equal((await r.syscallsFor(r.room).open(input)).ok, false);
  const retry = await r.syscallsFor(r.room).open(input);
  assert.ok(retry.ok);
  const children = await r.sessions.childrenOf(r.room.id);
  assert.equal(children.length, 1);
  assert.equal(retry.sessionId, children[0]!.id);
  assert.equal((await r.runs.inFlightForThread(children[0]!.threadRef)).length, 1);
  assert.equal((await r.syscallsFor(r.room).open({ ...input, task: "different work" })).ok, false);
});

test("retrying an unqueued child preserves detachment and uses its current tree capacity", async (t) => {
  const r = await rig({ treeRunCap: 1 });
  const enqueue = r.runs.enqueue.bind(r.runs);
  let fail = true;
  t.mock.method(r.runs, "enqueue", async (input: Parameters<RunStore["enqueue"]>[0]) => {
    if (fail) {
      fail = false;
      throw new Error("queue unavailable");
    }
    return enqueue(input);
  });
  const input = { requestId: "recover-detached", task: "work" };
  assert.equal((await r.syscallsFor(r.room).open(input)).ok, false);
  const [child] = await r.sessions.childrenOf(r.room.id);
  assert.ok(child);
  await r.sessions.setParentSession(child.id, null);
  await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, text: "busy", origin: { kind: "direct" } },
  });
  const retry = await r.syscallsFor(r.room).open(input);
  assert.ok(retry.ok);
  assert.equal(retry.sessionId, child.id);
  assert.equal(retry.liveRunsRemaining, 0);
  assert.equal((await r.sessions.get(child.id))?.parentSessionId ?? null, null);
});

test("siblings and children send durable deduplicated messages without new turns", async () => {
  const r = await rig();
  const parent = r.syscallsFor(r.room);
  const one = await parent.open({ task: "one", name: "one" });
  const two = await parent.open({ task: "two", name: "two" });
  assert.ok(one.ok && two.ok);
  const child = await freshSession(r.sessions, one.sessionId);
  const peer = await freshSession(r.sessions, two.sessionId);
  const sender = r.syscallsFor(child);
  const request = { target: "two", text: "shared finding", requestId: "message-one" };
  assert.equal((await sender.write(request)).ok, true);
  assert.equal((await sender.write(request)).ok, true);
  assert.equal((await r.runs.inFlightForThread(peer.threadRef)).length, 1);
  const receiver = r.syscallsFor(peer);
  const messages = await receiver.receive!();
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.text, /shared finding/);
  await receiver.acknowledge!([messages[0]!.id]);
  assert.deepEqual(await receiver.receive!(), []);
  const { run } = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, origin: { kind: "direct" }, text: "parent task" },
  });
  const claimed = await r.runs.claimById(run.id, "parent-worker", 30_000);
  await r.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "ready" });
  assert.equal((await sender.write({ target: "parent", text: "progress" })).ok, true);
  assert.equal((await parent.receive!()).length, 1);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);
});

test("follow-up retries recover the accepted run before checking full capacity", async (t) => {
  const r = await rig({ treeRunCap: 2 });
  const api = r.syscallsFor(r.room);
  const opened = await api.open({ task: "work" });
  assert.ok(opened.ok);
  const enqueue = r.runs.enqueue.bind(r.runs);
  let first = true;
  t.mock.method(r.runs, "enqueue", async (input: Parameters<RunStore["enqueue"]>[0]) => {
    const receipt = await enqueue(input);
    if (first) {
      first = false;
      throw new Error("lost receipt");
    }
    return receipt;
  });
  const request = { target: opened.sessionId, text: "more work", followup: true, requestId: "stable" };
  assert.equal((await api.write(request)).ok, false);
  assert.equal((await api.write(request)).ok, true);
  assert.equal((await api.write({ ...request, text: "changed" })).ok, false);
  const child = await freshSession(r.sessions, opened.sessionId);
  assert.equal((await r.runs.inFlightForThread(child.threadRef)).length, 2);
});

test("mailbox survives recreation and rejects acknowledgements for another recipient", async () => {
  const backing = createMemoryMap<SessionMessage>();
  const mail = createSessionMailbox(backing);
  const message: SessionMessage = {
    id: "one",
    senderId: "sender",
    recipientId: "recipient",
    actor,
    audience: [actor],
    text: "data",
    createdAt: 1,
  };
  await mail.send(message);
  await mail.send({ ...message, text: "replacement" });
  const restarted = createSessionMailbox(backing);
  await restarted.acknowledge("wrong", [message.id]);
  assert.equal((await restarted.pending("recipient"))[0]!.text, "data");
  await restarted.acknowledge("recipient", [message.id]);
  assert.deepEqual(await mail.pending("recipient"), []);
});

test("wait is cancelled and disabled actors cannot open or send", async () => {
  const r = await rig();
  let enabled = true;
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3, enabled: async () => enabled });
  const abort = new AbortController();
  const api = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, cancel: abort.signal },
  });
  const waiting = api.receive!(60_000);
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  enabled = false;
  assert.equal((await api.open({ task: "forbidden" })).ok, false);
  assert.equal((await api.write({ target: "any", text: "forbidden" })).ok, false);
});

test("queued results recheck source-entry visibility after participant tenure changes", async () => {
  const r = await rig();
  const other: Principal = { id: "U2", type: "internal" };
  const sharedScope = scopeId("group", "G1");
  const shared = await r.sessions.getOrCreateByThread("group:G1:mail-tenure", "group", sharedScope);
  for (const id of [actor.id, other.id]) await r.sessions.addParticipant(shared.id, id);
  const sharedConversation: Conversation = { kind: "group", threadRef: shared.threadRef, audience: [actor, other] };
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
  const api = factory.forTurn({
    session: shared,
    scopeId: sharedScope,
    request: { actor, conversation: sharedConversation },
  });
  const opened = await api.open({ task: "shared result" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const { lease } = await r.sessions.acquireLease(child.id);
  const entry = await r.sessions.append(lease!, {
    type: "assistant",
    payload: { text: "OLD_PRIVATE_RESULT" },
    scopeLabel: sharedScope,
  });
  await r.sessions.releaseLease(lease!);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  const claimed = await r.runs.claimById(run!.id, "child-worker", 30_000);
  await r.runs.complete(run!.id, claimed!.leaseToken!, {
    status: "ok",
    reply: "OLD_PRIVATE_RESULT",
    sourceAssistantEntrySeq: entry.seq,
  });
  await deliverSubagentMail(
    { sessions: r.sessions, runs: r.runs, mailbox: r.mailbox, maxAttempts: 3 },
    (await r.runs.get(run!.id))!,
  );
  assert.equal((await api.receive!()).length, 1);
  await r.sessions.removeParticipant(child.id, other.id);
  await r.sessions.addParticipant(child.id, other.id);
  assert.equal((await r.sessions.visibleEntries(child.id, other.id)).length, 0);
  assert.deepEqual(await api.receive!(), []);
  assert.equal((await r.mailbox.pending(shared.id)).length, 1);
});
