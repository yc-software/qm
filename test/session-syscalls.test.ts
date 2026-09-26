import { wireRunResultDeliveries, runResultDelivery } from "../src/delivery/run-result-delivery.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createControlService } from "../src/api/control-service.ts";
import { deliveryCandidatesFor } from "../src/core/orchestrator/turn-helpers.ts";
import { createMemoryMap, jsonbStringify } from "../src/persistence/durable-map.ts";
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
  requiresDelegation,
  sessionTreeRunCount,
  delegatedAuthorizationOrigin,
  stopSessionTree,
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

async function rig(opts?: {
  treeRunCap?: number;
  prepareRequest?: (request: OrchestratorInput) => Promise<OrchestratorInput>;
}): Promise<Rig> {
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
    ...(opts?.prepareRequest ? { prepareRequest: opts.prepareRequest } : {}),
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
  assert.equal(request.deliveryTarget, "D1");
  assert.match(request.text, /subagent-task/);
  assert.match(request.text, /build a personal website/);
  assert.equal(out.liveRunsRemaining, SUBAGENT_TREE_RUN_CAP - 1);
});

for (const explicit of [
  {},
  { fastMode: false },
  { model: "chosen-model", harness: "pi", thinkingLevel: "high", fastMode: false },
  { model: "chosen-model", fastMode: true },
]) {
  test(`child followups preserve only explicit runtime choices: ${JSON.stringify(explicit)}`, async () => {
    const runtimeKeys = ["model", "harness", "thinkingLevel", "fastMode"] as const;
    let defaults = { model: "old-default", harness: "codex", thinkingLevel: "low", fastMode: true };
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
    const claimed = await r.runs.claimById(first.id, "worker", 60_000);
    assert.ok(claimed);
    await r.runs.complete(first.id, claimed.leaseToken!, { status: "ok", reply: "done" });
    defaults = { model: "new-default", harness: "claude", thinkingLevel: "medium", fastMode: false };
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

test("a finished child durably wakes its Slack parent exactly once and leaves the result in its mailbox", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "summarize the logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "logs are clean" });
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
  assert.match(wakes[0]!.request.text, /Check internal messages/);
  assert.equal(wakes[0]!.request.surfaceTools, true);
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
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done alone" });
  const finished = await r.runs.get(queued.id);

  await deliverSubagentMail(
    { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3, delegationEnabled: async () => true },
    finished!,
  );
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);

  const read = await r.syscallsFor(r.room).read({ target: child.id });
  assert.ok(read.ok && read.mode === "tape");
});

test("another session cannot read or message an incognito session", async () => {
  const r = await rig();
  const secret = await r.sessions.getOrCreateByThread("web:U1:incognito", "dm", scope, undefined, "web", {
    incognito: true,
  });
  await r.sessions.addParticipant(secret.id, "U1");
  const syscalls = r.syscallsFor(r.room);
  for (const target of [secret.id, secret.threadRef]) {
    const read = await syscalls.read({ target });
    assert.ok(!read.ok, `read by ${target}`);
    const write = await syscalls.write({ target, text: "hi" });
    assert.ok(!write.ok, `write by ${target}`);
  }
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
  assert.match(wakes[0]!.request.text, /Check internal messages/);
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
  const claimed = await r.runs.claimById(queued!.id, "worker", 30_000);
  await r.runs.complete(queued!.id, claimed!.leaseToken!, { status: "ok", reply: "ready" });
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

test("completion cannot expand the finished run's audience and retries after its return delay", async (t) => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "private research" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  const claimed = await r.runs.claimById(run!.id, "worker", 60_000);
  await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: "private result" });
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
  assert.deepEqual(await r.runs.pendingReturns(), []);
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
    const receipt = await enqueue({ ...input, request: JSON.parse(jsonbStringify(input.request)) });
    if (first) {
      first = false;
      throw new Error("lost receipt");
    }
    return receipt;
  });
  const request = { target: opened.sessionId, text: "more\u0000 work\ud800", followup: true, requestId: "stable" };
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

test("enabled coordinators and their children can delegate", async () => {
  const r = await rig();
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3, enabled: async () => true });
  const api = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, surface: "slack" },
  });
  const opened = await api.open({ task: "Inspect the logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const childApi = factory.forTurn({
    session: child,
    scopeId: scope,
    request: { actor, conversation: { ...conversation, threadRef: child.threadRef }, surface: "slack" },
  });
  assert.ok((await childApi.open({ task: "Inspect an independent log" })).ok);
});

test("completion wakes preserve a spine trigger's delivery destination", async () => {
  const r = await rig();
  const destination = { type: "slack", target: "slack:C-trigger:100.1" };
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    dedupKey: "trigger-parent",
    maxAttempts: 3,
    request: {
      actor,
      conversation,
      surface: "slack",
      surfaceTools: true,
      origin: { kind: "automation", destination },
      text: "inspect logs",
    },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...parent.run.request, runId: parent.run.id },
  });
  const opened = await api.open({ task: "inspect logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  for (const pending of await r.runs.inFlightForThread(r.room.threadRef)) {
    const parentTurn = await r.runs.claimById(pending.id, "parent", 60_000);
    assert.ok(parentTurn);
    await r.runs.complete(pending.id, parentTurn.leaseToken!, { status: "silent" });
  }
  await deliverSubagentMail(
    { ...r, maxAttempts: 3, delegationEnabled: async () => true },
    (await r.runs.get(queued.id))!,
  );
  const wake = (await r.runs.inFlightForThread(r.room.threadRef)).find((run) => run.id !== parent.run.id)!;
  assert.ok(wake);
  assert.equal(wake.request.surfaceTools, true);
  assert.equal(wake.request.deliveryTarget, undefined);
  assert.ok(wake.request.origin.kind === "automation");
  assert.deepEqual(wake.request.origin.destination, destination);
});

test("delegated automation retains explicit unattended grants and owner-keychain authority", async () => {
  const r = await rig();
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
  const api = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: {
      actor,
      conversation,
      surface: "slack",
      origin: { kind: "automation", useOwnerKeychain: true, ownerResourcesRequireOpen: true },
      unattendedGrants: ["admin.sessions.read"],
    },
  });
  const opened = await api.open({ task: "prepare the scheduled report" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.deepEqual(queued.request.unattendedGrants, ["admin.sessions.read"]);
  assert.ok(queued.request.origin.kind === "automation");
  assert.equal(queued.request.origin.useOwnerKeychain, true);
  assert.equal(queued.request.origin.ownerResourcesRequireOpen, true);
  const claimed = await r.runs.claimById(queued.id, "w1", 60000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok((await api.write({ target: child.id, text: "finish the report", followup: true })).ok);
  const followup = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.deepEqual(followup.request.unattendedGrants, ["admin.sessions.read"]);
  assert.ok(followup.request.origin.kind === "automation");
  assert.equal(followup.request.origin.useOwnerKeychain, true);
  assert.equal(followup.request.origin.ownerResourcesRequireOpen, true);
});

test("follow-up tasks cannot inherit a prior caller's automation authority", async () => {
  const r = await rig();
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
  const privileged = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: {
      actor,
      conversation,
      surface: "slack",
      origin: { kind: "automation", useOwnerKeychain: true },
      unattendedGrants: ["admin.sessions.read"],
    },
  });
  const opened = await privileged.open({ task: "scheduled report" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok(
    (await r.syscallsFor(r.room).write({ target: child.id, text: "unprivileged follow-up", followup: true })).ok,
  );
  const next = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.equal(next.request.unattendedGrants, undefined);
  assert.ok(next.request.origin.kind === "automation");
  assert.equal(next.request.origin.useOwnerKeychain, undefined);
});

test("coordinator delegation requires an explicit actor rollout", () => {
  const request = { surface: "slack", conversation };
  assert.equal(requiresDelegation(request, false), false);
  assert.equal(requiresDelegation(request, true), true);
  assert.equal(requiresDelegation({ ...request, surface: "web" }, true), false);
  assert.equal(requiresDelegation({ ...request, surface: "web", surfaceTools: true }, true), true);
  assert.equal(
    requiresDelegation({ ...request, conversation: { ...conversation, threadRef: "agent:main:subagent:test" } }, true),
    false,
  );
});

test("disabled coordinators retain passive completion mail without a wake", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "inspect logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  await deliverSubagentMail(
    { ...r, maxAttempts: 3, delegationEnabled: async () => false },
    (await r.runs.get(queued.id))!,
  );
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);
});

async function delegatedHumanRig(context: Partial<OrchestratorInput> = {}) {
  const r = await rig();
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    dedupKey: "human-authority",
    request: {
      actor,
      conversation,
      surface: "slack",
      origin: { kind: "human" },
      addressed: true,
      text: "inspect",
      ...context,
    },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...parent.run.request, runId: parent.run.id },
  });
  const opened = await api.open({ task: "inspect" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  return { ...r, parent: parent.run, child, run, api };
}

test("delegated live authority follows immutable provenance without changing automation origin", async () => {
  const r = await delegatedHumanRig();
  assert.equal(r.run.request.origin.kind, "automation");
  assert.equal((await delegatedAuthorizationOrigin(r.run.request, r))?.kind, "human");
  for (const patch of [
    { actor: { ...actor, id: "other" } },
    { delegatingRunId: "missing" },
    { sessionSenderId: r.child.id },
    { privateSessionMessage: true as const },
    { readOnly: true },
    {
      conversation: { ...r.run.request.conversation, audience: [...conversation.audience, { ...actor, id: "other" }] },
    },
    { conversation: { ...r.run.request.conversation, kind: "channel" as const, channelRef: "other" } },
  ])
    assert.equal(await delegatedAuthorizationOrigin({ ...r.run.request, ...patch }, r), undefined);
  await r.sessions.setParentSession(r.child.id, null);
  assert.equal(await delegatedAuthorizationOrigin(r.run.request, r), undefined);
});

test("unrelated automated follow-ups cannot borrow earlier human authority", async () => {
  const r = await delegatedHumanRig();
  const claimed = await r.runs.claimById(r.run.id, "w1", 60000);
  await r.runs.complete(r.run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "slack", origin: { kind: "automation" }, text: "scheduled work" },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...parent.run.request, runId: parent.run.id },
  });
  assert.ok((await api.write({ target: r.child.id, text: "new scheduled task", followup: true })).ok);
  const next = (await r.runs.inFlightForThread(r.child.threadRef))[0]!;
  assert.equal(next.request.delegatingRunId, parent.run.id);
  assert.equal(await delegatedAuthorizationOrigin(next.request, r), undefined);
});

test("a later participant cannot change a completion's actor, rollout, destination, or grants", async () => {
  const r = await rig();
  const bob: Principal = { id: "U2", type: "internal" };
  const sharedScope = scopeId("channel", "C1");
  const room = await r.sessions.getOrCreateByThread("ch:C1:task", "channel", sharedScope, undefined, "slack");
  const sharedConversation: Conversation = {
    kind: "channel",
    channelRef: "C1",
    threadRef: room.threadRef,
    audience: [actor, bob],
    publishMembers: [actor, bob],
  };
  for (const person of [actor, bob]) await r.sessions.addParticipant(room.id, person.id);
  const parent = await r.runs.enqueue({
    sessionId: room.threadRef,
    request: {
      actor,
      conversation: sharedConversation,
      surface: "slack",
      surfaceTools: true,
      origin: { kind: "human" },
      deliveryTarget: "slack:C1:task",
      text: "inspect",
    },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: room,
    scopeId: sharedScope,
    request: { ...parent.run.request, runId: parent.run.id },
  });
  const opened = await api.open({ task: "inspect" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await r.runs.enqueue({
    sessionId: room.threadRef,
    request: {
      actor: bob,
      conversation: sharedConversation,
      surface: "slack",
      surfaceTools: true,
      origin: { kind: "automation", useOwnerKeychain: true, destination: { type: "slack", target: "unrelated" } },
      unattendedGrants: ["admin.sessions.read"],
      text: "unrelated",
    },
  });
  const claimed = await r.runs.claimById(queued.id, "w1", 60000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  for (const pending of await r.runs.inFlightForThread(room.threadRef)) {
    const parentTurn = await r.runs.claimById(pending.id, "parent", 60_000);
    assert.ok(parentTurn);
    await r.runs.complete(pending.id, parentTurn.leaseToken!, { status: "silent" });
  }
  await deliverSubagentMail(
    { ...r, maxAttempts: 3, delegationEnabled: async (id) => id === actor.id },
    (await r.runs.get(queued.id))!,
  );
  const wake = await r.runs.getByDedupKey(`subagent-return:${queued.id}`);
  assert.ok(wake);
  assert.equal(wake.request.actor.id, actor.id);
  assert.equal(wake.request.deliveryTarget, "slack:C1:task");
  assert.equal(wake.request.unattendedGrants, undefined);
  assert.deepEqual(wake.request.origin, { kind: "automation", screenData: wake.request.text });
});

test("completion wakes preserve live authorization for subsequent delegated steps", async () => {
  const r = await delegatedHumanRig();
  const claimed = await r.runs.claimById(r.run.id, "w1", 60000);
  await r.runs.complete(r.run.id, claimed!.leaseToken!, { status: "ok", reply: "step one" });
  for (const pending of await r.runs.inFlightForThread(r.room.threadRef)) {
    const parentTurn = await r.runs.claimById(pending.id, "parent", 60_000);
    assert.ok(parentTurn);
    await r.runs.complete(pending.id, parentTurn.leaseToken!, { status: "silent" });
  }
  await deliverSubagentMail(
    { ...r, maxAttempts: 3, delegationEnabled: async () => true },
    (await r.runs.get(r.run.id))!,
  );
  const wake = (await r.runs.getByDedupKey(`subagent-return:${r.run.id}`))!;
  assert.ok(wake);
  assert.equal(wake.request.origin.kind, "automation");
  assert.equal(wake.request.addressed, true);
  assert.equal((await delegatedAuthorizationOrigin(wake.request, r))?.kind, "human");
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...wake.request, runId: wake.id },
  });
  assert.ok((await api.write({ target: r.child.id, text: "step two", followup: true })).ok);
  const next = (await r.runs.inFlightForThread(r.child.threadRef))[0]!;
  assert.equal((await delegatedAuthorizationOrigin(next.request, r))?.kind, "human");
  await r.sessions.setParentSession(r.child.id, null);
  assert.equal(await delegatedAuthorizationOrigin(wake.request, r), undefined);
  assert.equal(await delegatedAuthorizationOrigin(next.request, r), undefined);
});

test("completed children do not fill a working parent's run slots and consumed returns settle", async () => {
  const r = await rig();
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "slack", origin: { kind: "human" }, text: "work" },
  });
  await r.runs.claimById(parent.run.id, "parent", 60_000);
  const deps = { ...r, maxAttempts: 3, delegationEnabled: async () => true };
  for (let i = 0; i < 12; i++) {
    const opened = await r.syscallsFor(r.room).open({ task: `work ${i}` });
    assert.ok(opened.ok);
    const child = await freshSession(r.sessions, opened.sessionId);
    const [run] = await r.runs.inFlightForThread(child.threadRef);
    const claimed = await r.runs.claimById(run!.id, "child", 60_000);
    await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: `result ${i}` });
    const finished = (await r.runs.get(run!.id))!;
    assert.equal(await deliverSubagentMail(deps, finished), false);
    assert.equal(await sessionTreeRunCount(r.sessions, r.runs, r.room), 1);
  }
  const pending = await r.runs.pendingReturns();
  assert.equal(pending.length, 12);
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
  const active = await r.runs.claimById(parent.run.id, "parent", 60_000);
  assert.deepEqual(await r.syscallsFor(r.room).receive!(), []);
  for (let i = 0; i < 3; i++) {
    const opened = await r.syscallsFor(r.room).open({ task: `late result ${i}` });
    assert.ok(opened.ok);
    const child = await freshSession(r.sessions, opened.sessionId);
    const [run] = await r.runs.inFlightForThread(child.threadRef);
    const claimed = await r.runs.claimById(run!.id, "child", 60_000);
    await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: `late ${i}` });
    assert.equal(await deliverSubagentMail(deps, (await r.runs.get(run!.id))!), false);
  }
  await r.runs.complete(parent.run.id, active!.leaseToken!, { status: "silent" });
  for (const run of await r.runs.pendingReturns()) assert.equal(await deliverSubagentMail(deps, run), false);
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1);
  const wake = await r.runs.claimById(wakes[0]!.id, "parent-restarted", 60_000);
  const mail = await r.syscallsFor(r.room).receive!();
  assert.equal(mail.length, 3);
  await r.syscallsFor(r.room).acknowledge!(mail.map((message) => message.id));
  for (const run of await r.runs.pendingReturns()) {
    assert.equal(await deliverSubagentMail(deps, run), true);
    await r.runs.markReturned(run.id);
  }
  assert.equal((await r.runs.get(wake!.id))!.status, "running");
  await r.runs.complete(wake!.id, wake!.leaseToken!, { status: "silent" });
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
  const claimed = await r.runs.claimById(run!.id, "child", 60_000);
  await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const finished = (await r.runs.get(run!.id))!;
  assert.equal(await deliverSubagentMail(deps, finished), false);
  await r.runs.markReturned(finished.id);
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
  const claimed = await r.runs.claimById(run!.id, "child", 60_000);
  await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const finished = (await r.runs.get(run!.id))!;
  await deliverSubagentMail(deps, finished);
  const wake = (await r.runs.inFlightForThread(r.room.threadRef))[0]!;
  const running = await r.runs.claimById(wake.id, "parent", 60_000);
  await r.mailbox.acknowledge(r.room.id, [`subagent-mail-${finished.id}`]);
  await r.runs.fail(wake.id, running!.leaseToken!, "transient failure", { retryAfterMs: 1000 });
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
      harness: "codex",
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
      queueMs: 50,
      approval: { requestId: "old-approval", approved: true },
      redeliveryKey: "old-envelope",
      proactiveOpener: true,
      intakePreambleMs: 20,
      clientSentAt: 5,
      attachments: [{ name: "old.txt", mimetype: "text/plain", sizeBytes: 1, blobId: "old-blob" }],
      inboundNotes: ["old input"],
      priorTurns: [],
      overheard: [],
      detectContext: "old detection",
      detectOpener: "old opener",
      conversationHeader: "old header",
    };
    const r = await delegatedHumanRig({ ...inherited, ...transient });
    const parent = await r.runs.claimById(r.parent.id, "parent", 60000);
    await r.runs.complete(r.parent.id, parent!.leaseToken!, { status: "silent" });
    const child = await r.runs.claimById(r.run.id, "child", 60000);
    await r.runs.complete(r.run.id, child!.leaseToken!, { status: "ok", reply: "verified result" });
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
    assert.equal(wake.request.origin.kind, "automation");
    assert.match(wake.request.text, /delegated task finished/i);
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
  test(`child ${status} forwards files once without creating approval deliveries`, async () => {
    const r = await rig();
    const deliveries = createDeliveryStore();
    const out = await r.syscallsFor(r.room).open({ task: "prepare the report" });
    assert.ok(out.ok);
    const child = await freshSession(r.sessions, out.sessionId);
    const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
    const claimed = await r.runs.claimById(run.id, "worker", 60_000);
    const attachment = { name: "report.pdf", blobId: "report", mimetype: "application/pdf", sizeBytes: 42 };
    await r.runs.complete(run.id, claimed!.leaseToken!, {
      status,
      attachments: [attachment],
      pendingApprovals: [{ requestId: "approve-report", command: "publish", reason: "needs consent" }],
    });
    const completed = (await r.runs.get(run.id))!;
    const deps = { ...r, maxAttempts: 3, deliveries };
    await deliverSubagentMail(deps, completed);
    await deliverSubagentMail(deps, completed);
    const files = await deliveries.pending("slack");
    assert.equal(files.length, 1);
    assert.deepEqual(files[0]!.attachments, [attachment]);
    assert.equal(files[0]!.destination.target, "D1");
    const approvals = await deliveries.pending("principal");
    assert.equal(approvals.length, 0);
    assert.match((await r.mailbox.pending(r.room.id))[0]!.text, /awaiting_input/);
  });
}

test("file-only child completion is a result", async () => {
  const r = await rig();
  const deliveries = createDeliveryStore();
  const out = await r.syscallsFor(r.room).open({ task: "make a chart" });
  assert.ok(out.ok);
  const child = await freshSession(r.sessions, out.sessionId);
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(run.id, "worker", 60_000);
  await r.runs.complete(run.id, claimed!.leaseToken!, {
    status: "ok",
    attachments: [{ name: "chart.png", blobId: "chart", mimetype: "image/png", sizeBytes: 1 }],
  });
  await deliverSubagentMail({ ...r, maxAttempts: 3, deliveries }, (await r.runs.get(run.id))!);
  assert.match((await r.mailbox.pending(r.room.id))[0]!.text, /Produced chart.png/);
});

test("stopping an idle coordinator cancels running and queued descendants and blocks new work", async () => {
  const r = await rig();
  const out = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(out.ok);
  const child = await freshSession(r.sessions, out.sessionId);
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(run.id, "worker", 60_000);
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
  await r.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "late result" });
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

test("stop still signals a queued child claimed during withdrawal", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "race the claim" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const runs = {
    ...r.runs,
    withdraw: async (id: string) => {
      await r.runs.claimById(id, "racer", 60_000);
      return false;
    },
  };
  await stopSessionTree({ ...r, runs }, r.room);
  assert.equal((await r.runs.get(run.id))!.status, "running");
  assert.equal((await r.signals.pending(run.id))[0]!.signal.kind, "abort");
});

for (const surface of ["slack", "web"] as const) {
  for (const nested of [false, true]) {
    test(`${surface}: ${nested ? "nested child" : "child"} results stay internal while files and parent replies deliver once`, async () => {
      const r = await rig();
      const deliveries = createDeliveryStore();
      wireRunResultDeliveries(r.runs, deliveries);
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
      const first = await r.runs.claimById(queued.id, "worker", 60_000);
      await r.runs.fail(queued.id, first!.leaseToken!, "transient", { retry: true });
      const claimed = await r.runs.claimById(queued.id, "worker", 60_000);
      const attachment = { name: "report.txt", blobId: "report", mimetype: "text/plain", sizeBytes: 42 };
      await r.runs.complete(queued.id, claimed!.leaseToken!, {
        status: "ok",
        reply: "INTERNAL_CHILD_REPORT: suggested answer for parent",
        attachments: [attachment],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        await deliveries.pending(surface),
        [],
        "terminal listener must not publish child results or files",
      );
      const completed = (await r.runs.get(queued.id))!;
      assert.equal(
        runResultDelivery(JSON.parse(JSON.stringify(completed))),
        null,
        "serialized terminal runs remain internal",
      );
      const deps = { ...r, maxAttempts: 3, deliveries };
      await deliverSubagentMail(deps, completed);
      await deliverSubagentMail(deps, completed);
      const mail = await r.mailbox.pending(parent.id);
      assert.equal(mail.length, 1);
      assert.match(mail[0]!.text, /INTERNAL_CHILD_REPORT/);
      const files = await deliveries.pending(surface);
      assert.equal(files.length, 1);
      assert.equal(files[0]!.text, "");
      assert.deepEqual(files[0]!.attachments, [attachment]);
      assert.equal(files[0]!.destination.target, "D1");
      const parentRun = (await r.runs.enqueue({ sessionId: r.room.threadRef, request })).run;
      const parentClaim = await r.runs.claimById(parentRun.id, "parent", 60_000);
      await r.runs.complete(parentRun.id, parentClaim!.leaseToken!, { status: "ok", reply: "PUBLIC_PARENT_ANSWER" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const publicResults = await deliveries.pending(surface);
      assert.deepEqual(publicResults.map((item) => item.text).filter(Boolean), ["PUBLIC_PARENT_ANSWER"]);
      assert.equal(publicResults.filter((item) => item.attachments?.length).length, 1);
    });
  }
}
