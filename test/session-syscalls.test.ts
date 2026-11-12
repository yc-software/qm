import { randomUUID } from "node:crypto";
import { wireRunResultDeliveries, runResultDelivery } from "../src/delivery/run-result-delivery.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createControlService } from "../src/api/control-service.ts";
import { deliveryCandidatesFor } from "../src/core/orchestrator/turn-helpers.ts";
import { jsonbStringify } from "../src/util/text.ts";
import { createSessionMailbox, type SessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionSyscalls,
  isSubagentThreadRef,
  requiresDelegation,
  sessionTreeRuns,
  delegatedAuthorizationOrigin,
  stopSessionTree,
  sessionContextOf,
  stopSessionRuns,
  PARENT_INTERRUPT,
  USER_STOP,
  USER_STOP_ALL,
  runStopped,
  ANCESTOR_STOP,
  type SessionSyscallDeps,
} from "../src/sessions/session-syscalls.ts";
import {
  deliverSubagentMail,
  renderSubagentMail,
  settleTreeWakes,
  sweepUnreadMailWakes,
  wakeForUnreadMail,
} from "../src/sessions/subagent-mail.ts";
import { scopeId, type Conversation, type Principal, type ScopeId, type Session } from "../src/types.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { Run, RunStore } from "../src/runs/run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import type { AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "./support/test-database.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import type { RunSignal } from "../src/runs/run-signal-store.ts";
import { liveSubagentsNote } from "../src/sessions/subagent-status.ts";

const unexpectedSteer: SessionSyscallDeps["steerRun"] = async () => {
  throw new Error("unexpected steer");
};

const actor: Principal = { id: "U1", type: "internal", displayName: "Alex" };
const scope: ScopeId = scopeId("personal", "U1");
const conversation: Conversation = { kind: "dm", threadRef: "slack:dm:D1", audience: [actor] };

interface Rig {
  mailbox: SessionMailbox;
  sessions: SessionStore;
  runs: RunStore;
  signals: ReturnType<typeof createPostgresRunSignalStore>;
  advisoryLock: AdvisoryLock;
  steerRun: SessionSyscallDeps["steerRun"];
  room: Session;
  syscallsFor(session: Session): ReturnType<ReturnType<typeof createSessionSyscalls>["forTurn"]>;
}

async function rig(opts?: {
  prepareRequest?: (request: OrchestratorInput) => Promise<OrchestratorInput>;
}): Promise<Rig> {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const signals = createPostgresRunSignalStore(testDatabaseUrl());
  const mailbox = createSessionMailbox(testMap<SessionMessage>(["recipientId", "wake"]));
  const advisoryLock = testAdvisoryLock();
  const steerRun: SessionSyscallDeps["steerRun"] = async (run, signal) => ({
    sent: await signals.send(run.id, signal),
  });
  const factory = createSessionSyscalls({
    mailbox,
    sessions,
    runs,
    signals,
    steerRun,
    advisoryLock,
    maxAttempts: 3,
    ...(opts?.prepareRequest ? { prepareRequest: opts.prepareRequest } : {}),
  });
  const room = await recordContext(
    sessions,
    await sessions.getOrCreateByThread("slack:dm:D1", "dm", scope, undefined, "slack"),
    { actor, conversation, surface: "slack", deliveryTarget: "D1", timezone: "America/Los_Angeles" },
  );
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
    advisoryLock,
    steerRun,
    room,
    syscallsFor: (session) => factory.forTurn(binding(session)),
  };
}

async function recordContext(
  sessions: SessionStore,
  session: Session,
  request: Pick<OrchestratorInput, "actor" | "conversation"> & Partial<OrchestratorInput>,
): Promise<Session> {
  return sessions.getOrCreateByThread(
    session.threadRef,
    session.type,
    session.scopeId,
    undefined,
    undefined,
    undefined,
    {
      context: sessionContextOf({ origin: { kind: "human" }, surface: "web", text: "", ...request }),
    },
  );
}

async function freshSession(sessions: SessionStore, id: string): Promise<Session> {
  const s = await sessions.get(id);
  assert.ok(s);
  return s;
}

test("side chats cannot launch subagents until opened as a full session", async () => {
  const r = await rig();
  const sideChat = { entrySeq: 0, quote: "selected passage", occurrence: 0, expanded: false };
  const blocked = await r.syscallsFor({ ...r.room, sideChat }).open({ task: "research this passage" });
  assert.equal(blocked.ok, false);
  assert.deepEqual(await r.sessions.childrenOf(r.room.id), []);
  const opened = await r
    .syscallsFor({ ...r.room, sideChat: { ...sideChat, expanded: true } })
    .open({ task: "research this passage" });
  assert.equal(opened.ok, true);
});

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
    const claimed = await r.runs.claimById(first.id, "worker", 60_000);
    assert.ok(claimed);
    await r.runs.complete(first.id, claimed.leaseToken!, { status: "ok", reply: "done" });
    defaults = { model: "new-default", thinkingLevel: "medium", fastMode: false };
    const followup = await syscalls.write({ wake: true, target: child.id, text: "next task" });
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

test("empty writes name the field the caller must fill", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const message = await r.syscallsFor(r.room).write({ target: opened.sessionId, text: "  " });
  assert.ok(!message.ok);
  assert.match(message.message, /^send_message requires `text`/);
  const self = await r.syscallsFor(r.room).write({ target: r.room.id, text: "hi" });
  assert.ok(!self.ok);
  assert.match(self.message, /cannot message itself/);
});

test("a wake never turns an ordinary session into a child and only leaves mail while it is busy", async () => {
  const r = await rig();
  const ordinary = await r.sessions.getOrCreateByThread("web:ordinary", "dm", scope, undefined, "web");
  await r.sessions.addParticipant(ordinary.id, actor.id);
  await recordContext(r.sessions, ordinary, { actor, conversation, surface: "web" });
  await r.runs.enqueue({
    sessionId: ordinary.threadRef,
    request: { actor, conversation, surface: "web", origin: { kind: "human" }, text: "hello" },
  });
  const out = await r.syscallsFor(r.room).write({ wake: true, target: ordinary.id, text: "new task" });
  assert.ok(out.ok);
  assert.deepEqual([out.delivered, out.busy, out.notWoken], ["queued_message", true, undefined]);
  assert.equal((await freshSession(r.sessions, ordinary.id)).parentSessionId, undefined);
  assert.equal((await r.runs.inFlightForThread(ordinary.threadRef)).length, 1);
});

test("a wake steers a busy child's running turn or starts an idle child's turn; wake:false only leaves mail", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const [first] = await r.runs.inFlightForThread(child.threadRef);
  const claimed = await r.runs.claimById(first!.id, "worker", 60_000);
  const busy = await r.syscallsFor(r.room).write({ wake: true, target: child.id, text: "review again" });
  assert.ok(busy.ok);
  assert.deepEqual([busy.delivered, busy.busy], ["steered", true]);
  assert.equal((await r.runs.inFlightForThread(child.threadRef)).length, 1);
  assert.deepEqual(
    (await r.signals.takePending(first!.id)).map((signal) => [signal.kind, signal.text]),
    [["steer", "review again"]],
  );
  await r.runs.complete(first!.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const quiet = await r.syscallsFor(r.room).write({ wake: false, target: child.id, text: "fyi" });
  assert.ok(quiet.ok);
  assert.deepEqual([quiet.delivered, quiet.busy], ["queued_message", false]);
  assert.equal((await r.runs.inFlightForThread(child.threadRef)).length, 0);
  assert.equal((await r.mailbox.pending(child.id)).length, 1);
  const idle = await r.syscallsFor(r.room).write({ wake: true, target: child.id, text: "one more pass" });
  assert.ok(idle.ok);
  assert.deepEqual([idle.delivered, idle.busy], ["queued_turn", false]);
  assert.equal((await r.runs.inFlightForThread(child.threadRef)).length, 1);
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

test("a tree opens subagents past fifty runs in flight", async () => {
  const r = await rig();
  for (let i = 0; i < 51; i++) assert.ok((await r.syscallsFor(r.room).open({ task: `work ${i}` })).ok);
  assert.equal((await sessionTreeRuns(r.sessions, r.runs, r.room)).length, 51);
});
test("a subagent's message to a busy sibling steers the sibling's running turn", async () => {
  const r = await rig();
  const sender = await runningChild(r, r.room, "review");
  const target = await runningChild(r, r.room, "build");
  const out = await r
    .syscallsFor(sender.session)
    .write({ wake: true, target: target.session.id, text: "auth is broken" });
  assert.deepEqual(out.ok && [out.delivered, out.busy], ["steered", true]);
  const [steer] = await r.signals.takePending(target.run.id);
  assert.equal(steer?.kind, "steer");
  assert.equal(steer.text, "auth is broken");
  assert.equal(steer.request?.sessionSenderId, sender.session.id);
  assert.deepEqual(
    (await r.runs.inFlightForThread(target.session.threadRef)).map((run) => run.id),
    [target.run.id],
  );
});

test("write steers a running child's turn and interrupts explicitly", async () => {
  const r = await rig();
  const syscalls = r.syscallsFor(r.room);
  const opened = await syscalls.open({ task: "watch the deploy", name: "watch_deploy" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  assert.ok(claimed);

  const steered = await syscalls.write({ wake: true, target: opened.sessionId, text: "focus on the canary" });
  assert.ok(steered.ok);
  assert.equal(steered.delivered, "steered");
  const [steer] = await r.signals.takePending(queued.id);
  assert.equal(steer?.kind, "steer");
  assert.equal(steer.text, "focus on the canary");
  assert.equal(steer.request?.sessionSenderId, r.room.id);
  assert.equal(steer.request?.displayText, "focus on the canary");
  assert.match(steer.request?.text ?? "", /^<subagent-message [^>]*>\nfocus on the canary\n<\/subagent-message>$/);
  assert.ok(steer.request?.text.includes(`fromSessionId="${r.room.id}"`));
  assert.deepEqual(
    (await r.runs.inFlightForThread(child.threadRef)).map((run) => run.id),
    [queued.id],
  );

  const interrupted = await syscalls.write({ target: opened.sessionId, interrupt: true });
  assert.ok(interrupted.ok);
  assert.equal(interrupted.delivered, "interrupted");
  assert.equal((await r.signals.takePending(queued.id))[0]!.kind, "abort");

  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const retask = await syscalls.write({ wake: true, target: "watch_deploy", text: "check it again" });
  assert.ok(retask.ok);
  assert.equal(retask.delivered, "queued_turn");
  const rerun = await r.runs.inFlightForThread(child.threadRef);
  assert.equal(rerun.length, 1);
  assert.ok(rerun.some((run) => /check it again/.test(run.request.text)));
});

test("a message whose running turn ended before the steer landed is replayed as a turn instead of being lost", async () => {
  const r = await rig();
  const target = await runningChild(r, r.room, "build");
  const steers: Array<[string, RunSignal]> = [];
  const api = createSessionSyscalls({
    ...r,
    steerRun: async (run, signal) => {
      steers.push([run.id, signal]);
      return { sent: true, terminal: true, drained: true, replayRunId: "replayed-run" };
    },
    maxAttempts: 3,
  }).forTurn({ session: r.room, scopeId: scope, request: { surface: "slack", conversation, actor } });
  const out = await api.write({ target: target.session.id, wake: true, text: "keep going" });
  assert.equal(out.ok && out.delivered, "queued_turn");
  assert.deepEqual(
    steers.map(([runId, signal]) => [runId, signal.text, signal.request?.spawned, signal.request?.sessionSenderId]),
    [[target.run.id, "keep going", true, r.room.id]],
  );
  const refusing = createSessionSyscalls({
    ...r,
    steerRun: async () => ({ sent: true, terminal: true, drained: true }),
    maxAttempts: 3,
  }).forTurn({ session: r.room, scopeId: scope, request: { surface: "slack", conversation, actor } });
  const refused = await refusing.write({ target: target.session.id, wake: true, text: "keep going" });
  assert.equal(refused.ok, false);
});

test("a retried message with the same requestId steers the running turn once", async () => {
  const r = await rig();
  const target = await runningChild(r, r.room, "build");
  const { api } = await parentRun(r);
  const first = await api.write({ target: target.session.id, wake: true, text: "use v2", requestId: "k1" });
  const again = await api.write({ target: target.session.id, wake: true, text: "use v2", requestId: "k1" });
  assert.deepEqual([first.ok && first.delivered, again.ok && again.delivered], ["steered", "steered"]);
  assert.deepEqual(
    (await r.signals.pending(target.run.id)).map(({ signal }) => [signal.kind, signal.text]),
    [["steer", "use v2"]],
  );
  assert.equal((await r.runs.inFlightForThread(target.session.threadRef)).length, 1);
});

test("an interrupt or a read-only sender's message to a writable running turn starts a turn instead of steering", async () => {
  const r = await rig();
  const target = await runningChild(r, r.room, "build");
  const readOnly = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { surface: "slack", conversation, actor, readOnly: true },
  });
  const queued = await readOnly.write({ target: target.session.id, wake: true, text: "look again" });
  assert.deepEqual(queued.ok && [queued.delivered, queued.busy], ["queued_turn", true]);
  const interrupted = await r
    .syscallsFor(r.room)
    .write({ target: target.session.id, wake: true, interrupt: true, text: "new plan" });
  assert.equal(interrupted.ok && interrupted.delivered, "interrupted");
  assert.deepEqual(
    (await r.signals.pending(target.run.id)).map(({ signal }) => signal.kind),
    ["abort"],
  );
});

test("a Slack bot can't reach a person's running subagent or interrupt a person's turn in its own task", async () => {
  const r = await rig();
  const target = await runningChild(r, r.room, "build");
  const bot: Principal = { id: "B1", type: "internal", displayName: "Release bot" };
  await r.sessions.addParticipant(target.session.id, bot.id);
  const fromBot = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { surface: "slack", conversation, actor: bot, botActor: true },
  });
  const hidden = await fromBot.read({ target: target.session.id });
  assert.equal(hidden.ok, false);
  for (const mode of [{}, { wake: true }, { interrupt: true }])
    assert.deepEqual(await fromBot.write({ target: target.session.id, text: "drop it", ...mode }), hidden);
  const botTask = await fromBot.open({ task: "summarize the release" });
  assert.ok(botTask.ok);
  const botRun = (await r.runs.inFlightForThread((await r.sessions.get(botTask.sessionId))!.threadRef))[0]!;
  assert.ok(await r.runs.claimById(botRun.id, "worker", 60_000));
  const followUp = await r
    .syscallsFor(r.room)
    .write({ target: botTask.sessionId, wake: true, text: "include the changelog" });
  assert.deepEqual(followUp.ok && followUp.delivered, "queued_turn");
  const overPerson = await fromBot.write({ target: botTask.sessionId, interrupt: true, text: "skip it" });
  assert.deepEqual(overPerson, { ok: false, message: "a Slack bot's turn cannot interrupt a person's task" });
  assert.deepEqual(await r.signals.pending(target.run.id), []);
});

async function queuedMessage(r: Rig, target: { session: Session; run: Run }, sender: Session, text: string) {
  const { run } = await r.runs.enqueue({
    sessionId: target.session.threadRef,
    request: { ...target.run.request, sessionSenderId: sender.id, text, displayText: text },
  });
  return run;
}

async function runningChild(r: Rig, parent: Session, task: string) {
  const opened = await r.syscallsFor(parent).open({ task });
  assert.ok(opened.ok);
  const session = await freshSession(r.sessions, opened.sessionId);
  const run = (await r.runs.inFlightForThread(session.threadRef))[0]!;
  const claimed = await r.runs.claimById(run.id, "worker", 60_000);
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session,
    scopeId: scope,
    request: { ...run.request, runId: run.id },
  });
  return { session, run, leaseToken: claimed!.leaseToken!, api };
}

test("an interrupt stops only its target's run; the target's own subagent keeps working and reports back", async () => {
  const r = await rig();
  const lead = await runningChild(r, r.room, "lead the work");
  const opened = await lead.api.open({ task: "one lane" });
  assert.ok(opened.ok);
  const laneSession = await freshSession(r.sessions, opened.sessionId);
  const laneRun = (await r.runs.inFlightForThread(laneSession.threadRef))[0]!;
  const laneClaim = await r.runs.claimById(laneRun.id, "worker", 60_000);
  const lane = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: laneSession,
    scopeId: scope,
    request: { ...laneRun.request, runId: laneRun.id },
  });

  const interrupted = await r.syscallsFor(r.room).write({ target: lead.session.id, interrupt: true });
  assert.ok(interrupted.ok);
  assert.equal(interrupted.delivered, "interrupted");
  assert.equal((await r.signals.pending(lead.run.id))[0]!.signal.kind, "abort");
  assert.deepEqual(await r.signals.pending(laneRun.id), []);
  assert.equal((await r.runs.get(laneRun.id))!.status, "running");
  assert.ok((await lane.read({})).ok);
  await r.runs.complete(lead.run.id, lead.leaseToken, {
    status: "silent",
    stopped: true,
    stopScope: "run",
  });
  assert.ok((await lane.read({})).ok);

  await r.runs.complete(laneRun.id, laneClaim!.leaseToken!, { status: "ok", reply: "lane finished" });
  assert.equal(await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(laneRun.id))!), false);
  const [mail] = await r.mailbox.pending(lead.session.id);
  assert.match(mail!.text, /lane finished/);
  const [wake] = await r.runs.inFlightForThread(lead.session.threadRef);
  assert.equal(wake!.dedupKey, `subagent-return:${laneRun.id}`);
});

test("an interrupt with text makes that text the target's next turn", async () => {
  const r = await rig();
  const child = await runningChild(r, r.room, "watch the deploy");
  const out = await r
    .syscallsFor(r.room)
    .write({ target: child.session.id, interrupt: true, text: "check the canary" });
  assert.ok(out.ok);
  assert.equal(out.delivered, "interrupted");
  assert.equal((await r.signals.pending(child.run.id))[0]!.signal.kind, "abort");
  await r.runs.complete(child.run.id, child.leaseToken, { status: "ok", reply: "", stopped: true });
  const [next] = await r.runs.inFlightForThread(child.session.threadRef);
  assert.match(next!.request.text, /check the canary/);
  assert.equal(next!.request.delegatingRunId, undefined);
  assert.equal(next!.request.sessionSenderId, r.room.id);

  const replaced = await r.syscallsFor(r.room).write({
    target: child.session.id,
    interrupt: true,
    text: "only the logs",
  });
  assert.ok(replaced.ok);
  assert.equal(replaced.delivered, "interrupted");
  const queued = await r.runs.inFlightForThread(child.session.threadRef);
  assert.deepEqual(
    queued.map((run) => run.request.displayText),
    ["only the logs"],
  );
});

test("a subagent's wake starts a turn in its top-level parent, or leaves mail while the parent is busy", async () => {
  const r = await rig();
  const child = await runningChild(r, r.room, "investigate");
  const asked = await child.api.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
  assert.ok(asked.ok);
  assert.deepEqual([asked.delivered, asked.busy], ["queued_turn", false]);
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.request.sessionSenderId, child.session.id);
  assert.equal(wakes[0]!.request.actor.id, actor.id);
  assert.equal(wakes[0]!.request.readOnly, undefined);
  assert.equal(wakes[0]!.request.privateSessionMessage, undefined);
  assert.equal(wakes[0]!.request.conversation.threadRef, r.room.threadRef);
  const [mail] = await r.mailbox.pending(r.room.id);
  assert.match(mail!.text, /which region\?/);

  const retried = await child.api.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
  assert.ok(retried.ok);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 1);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);

  const again = await child.api.write({ target: "parent", wake: true, text: "also: which account?" });
  assert.ok(again.ok);
  assert.deepEqual([again.delivered, again.busy], ["queued_message", true]);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 1);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 2);
});

test("a subagent cannot start a turn in a top-level conversation that is not its own parent", async () => {
  const r = await rig();
  const child = await runningChild(r, r.room, "lead");
  const grandchild = await runningChild(r, child.session, "lane");
  const out = await grandchild.api.write({ target: r.room.id, wake: true, text: "skip the lead" });
  assert.ok(out.ok);
  assert.equal(out.delivered, "queued_message");
  assert.ok(out.notWoken);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 0);
  const ordinary = await r.sessions.getOrCreateByThread("web:U1:other", "dm", scope, undefined, "web");
  await r.sessions.addParticipant(ordinary.id, actor.id);
  await recordContext(r.sessions, ordinary, { actor, conversation, surface: "web" });
  const stranger = await child.api.write({ target: ordinary.id, wake: true, text: "hello" });
  assert.ok(stranger.ok);
  assert.equal(stranger.delivered, "queued_message");
  assert.equal((await r.runs.inFlightForThread(ordinary.threadRef)).length, 0);
});

async function parentRun(r: Rig, botActor = false) {
  const { run } = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: {
      actor,
      conversation,
      surface: "slack",
      deliveryTarget: "D1",
      origin: { kind: "human" },
      text: "go",
      ...(botActor ? { botActor } : {}),
    },
  });
  const claimed = await r.runs.claimById(run.id, "worker", 60_000);
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...run.request, runId: run.id },
  });
  return { run, leaseToken: claimed!.leaseToken!, api };
}

async function leadOf(r: Rig, p: Awaited<ReturnType<typeof parentRun>>) {
  const opened = await p.api.open({ task: "lead" });
  assert.ok(opened.ok);
  const session = await freshSession(r.sessions, opened.sessionId);
  const run = (await r.runs.inFlightForThread(session.threadRef))[0]!;
  const claimed = await r.runs.claimById(run.id, "worker", 60_000);
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session,
    scopeId: scope,
    request: { ...run.request, runId: run.id },
  });
  return { session, run, leaseToken: claimed!.leaseToken!, api };
}

test("a user stop of an ancestor run stops a descendant that starts later, whatever its reason text", async () => {
  for (const reason of ["by user", "because its goal was cancelled", PARENT_INTERRUPT]) {
    const r = await rig();
    const p = await parentRun(r);
    const lead = await leadOf(r, p);
    assert.ok((await lead.api.read({})).ok);
    await r.signals.send(p.run.id, { kind: "abort", reason });
    await assert.rejects(lead.api.read({}), /stopped/);
    await r.runs.complete(p.run.id, p.leaseToken, { status: "silent", stopped: true });
    await assert.rejects(lead.api.read({}), /stopped/);
  }
});

test("a user's Stop on the parent leaves its subagent working, and the subagent's question and result still wake the parent", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
  const p = await parentRun(r);
  const lead = await leadOf(r, p);
  assert.deepEqual(await stopSessionRuns(r, r.room, { reason: USER_STOP, scope: "session" }), [
    { id: p.run.id, withdrawn: false },
  ]);
  assert.deepEqual(await r.signals.pending(lead.run.id), []);
  assert.ok((await lead.api.read({})).ok);
  const asked = await lead.api.write({ target: "parent", wake: true, text: "which region?" });
  assert.ok(asked.ok);
  assert.equal(asked.delivered, "queued_message");
  await r.runs.complete(p.run.id, p.leaseToken, { status: "silent", stopped: true, stopScope: "session" });
  assert.ok((await lead.api.read({})).ok);

  assert.equal(await wakeForUnreadMail(deps, (await r.runs.get(p.run.id))!), "woken");
  const [woken] = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(woken!.request.delegatingRunId, p.run.id);
  const wokenClaim = await r.runs.claimById(woken!.id, "worker", 60_000);
  const wokenApi = createSessionSyscalls(deps).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...woken!.request, runId: woken!.id },
  });
  assert.ok((await wokenApi.read({})).ok);
  await r.mailbox.acknowledge(
    r.room.id,
    (await r.mailbox.pending(r.room.id)).map((mail) => mail.id),
  );
  await r.runs.complete(woken!.id, wokenClaim!.leaseToken!, { status: "ok", reply: "us-east" });

  await r.runs.complete(lead.run.id, lead.leaseToken, { status: "ok", reply: "lead finished" });
  await deliverSubagentMail(deps, (await r.runs.get(lead.run.id))!);
  const [returned] = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(returned?.dedupKey, `subagent-return:${lead.run.id}`);
  assert.match((await r.mailbox.pending(r.room.id))[0]!.text, /lead finished/);
});

async function delegatedLanes(r: Rig, tasks: string[], botActor = false) {
  const opener = await parentRun(r, botActor);
  const lanes = [];
  for (const task of tasks) {
    const opened = await opener.api.open({ task });
    assert.ok(opened.ok);
    const session = await freshSession(r.sessions, opened.sessionId);
    const run = (await r.runs.inFlightForThread(session.threadRef))[0]!;
    const claim = await r.runs.claimById(run.id, "worker", 60_000);
    const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
      session,
      scopeId: scope,
      request: { ...run.request, runId: run.id },
    });
    lanes.push({ session, run, leaseToken: claim!.leaseToken!, api });
  }
  await r.runs.complete(opener.run.id, opener.leaseToken, { status: "ok", reply: "started the work" });
  return lanes;
}

test("a return deferred while the parent was busy wakes the parent once a Stop of that conversation alone ends the turn", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
  const [lane] = await delegatedLanes(r, ["work"]);
  const busy = await parentRun(r);
  await r.runs.complete(lane!.run.id, lane!.leaseToken, { status: "ok", reply: "child result" });
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane!.run.id))!), false);
  await stopSessionRuns(r, r.room, { reason: USER_STOP, scope: "session" });
  await r.runs.complete(busy.run.id, busy.leaseToken, { status: "silent", stopped: true, stopScope: "session" });
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane!.run.id))!), false);
  assert.deepEqual(
    (await r.runs.inFlightForThread(r.room.threadRef)).map((run) => run.dedupKey),
    [`subagent-return:${lane!.run.id}`],
  );
});

test("stopping everything leaves the tree's waiting results and questions as mail and starts no parent turn", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
  const [early, asker, late] = await delegatedLanes(r, ["early", "asker", "late"]);
  await r.runs.complete(early!.run.id, early!.leaseToken, { status: "ok", reply: "early result" });
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(early!.run.id))!), false);
  const [queuedWake] = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(queuedWake?.dedupKey, `subagent-return:${early!.run.id}`);
  const asked = await asker!.api.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
  assert.equal(asked.ok && asked.delivered, "queued_message");
  await r.runs.complete(asker!.run.id, asker!.leaseToken, { status: "ok", reply: "asked" });
  await r.runs.complete(late!.run.id, late!.leaseToken, { status: "ok", reply: "late result" });
  for (const lane of [asker!, late!]) {
    assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane.run.id))!), false);
    await r.runs.deferReturn(lane.run.id, 60_000);
  }
  await settleTreeWakes(deps, r.room);
  await stopSessionTree(r, r.room, USER_STOP_ALL);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
  assert.deepEqual(
    await r.runs.pendingReturns(
      100,
      "",
      [early!, asker!, late!].map((lane) => lane.session.threadRef),
    ),
    [],
  );
  const next = await parentRun(r);
  await r.runs.complete(next.run.id, next.leaseToken, { status: "silent", stopped: true, stopScope: "session" });
  assert.equal(await wakeForUnreadMail(deps, (await r.runs.get(next.run.id))!), undefined);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
  const mail = await r.mailbox.pending(r.room.id);
  assert.equal(mail.length, 4);
  assert.ok(mail.every((message) => message.wake === undefined));
});

test("a Slack bot's stop settles only the bot's own waiting results and questions in the tree", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
  const [person] = await delegatedLanes(r, ["person work"]);
  const [bot] = await delegatedLanes(r, ["bot work"], true);
  for (const lane of [person!, bot!]) {
    await lane.api.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
    await r.runs.complete(lane.run.id, lane.leaseToken, { status: "ok", reply: "result" });
    assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane.run.id))!), false);
    await r.runs.deferReturn(lane.run.id, 60_000);
  }
  await settleTreeWakes(deps, r.room, true);
  assert.deepEqual(
    {
      returns: (await r.runs.pendingReturns(100, "", [person!.session.threadRef, bot!.session.threadRef])).map(
        (run) => run.id,
      ),
      wakes: [...new Set((await r.mailbox.wakesFor(r.room.id)).map((message) => message.senderId))],
    },
    { returns: [person!.run.id], wakes: [person!.session.id] },
  );
});

test("settling a stopped tree skips a result it cannot deliver and only returns ordinary runs of subagents", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
  const [lane] = await delegatedLanes(r, ["work"]);
  await r.runs.complete(lane!.run.id, lane!.leaseToken, { status: "ok", reply: "child result" });
  const failing = {
    ...deps,
    prepareRequest: async () => {
      throw new Error("no runtime context");
    },
  };
  await settleTreeWakes(failing, r.room);
  assert.deepEqual(
    (await r.runs.pendingReturns(100, "", [r.room.threadRef, lane!.session.threadRef])).map((run) => run.id),
    [lane!.run.id],
  );
});

test("a Stop keeps a parent run that is parked for retry, so its subagent keeps its delegation", async () => {
  const r = await rig();
  const p = await parentRun(r);
  const opened = await p.api.open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const childRun = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.ok(await r.runs.releaseLease(p.run.id, p.leaseToken));
  assert.equal((await stopSessionRuns(r, r.room, { reason: USER_STOP, scope: "session" })).length, 1);
  assert.ok(await r.runs.get(p.run.id));
  assert.equal(await runStopped(r.runs, r.signals, childRun.id), undefined);
});

test("an interrupt keeps a started lead run that is parked for retry, so its lane can still report back", async () => {
  const r = await rig();
  const lead = await runningChild(r, r.room, "lead");
  const opened = await lead.api.open({ task: "lane" });
  assert.ok(opened.ok);
  const lane = await freshSession(r.sessions, opened.sessionId);
  const laneRun = (await r.runs.inFlightForThread(lane.threadRef))[0]!;
  const laneClaim = await r.runs.claimById(laneRun.id, "worker", 60_000);
  assert.ok(await r.runs.releaseLease(lead.run.id, lead.leaseToken));
  const out = await r.syscallsFor(r.room).write({ target: lead.session.id, interrupt: true, text: "new plan" });
  assert.ok(out.ok);
  assert.equal(out.delivered, "interrupted");
  assert.ok(await r.runs.get(lead.run.id));
  assert.deepEqual(await r.signals.pending(laneRun.id), []);
  await r.runs.complete(laneRun.id, laneClaim!.leaseToken!, { status: "ok", reply: "lane done" });
  assert.equal(await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(laneRun.id))!), false);
  assert.equal((await r.mailbox.pending(lead.session.id)).length, 1);
  assert.equal(await r.runs.getByDedupKey(`subagent-return:${laneRun.id}`), null);
});

async function claimedChild(r: Rig, sessionId: string) {
  const session = await freshSession(r.sessions, sessionId);
  const run = (await r.runs.inFlightForThread(session.threadRef))[0]!;
  const claimed = await r.runs.claimById(run.id, "worker", 60_000);
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session,
    scopeId: scope,
    request: { ...run.request, runId: run.id },
  });
  return { session, run, leaseToken: claimed!.leaseToken!, api };
}

async function delegatedTree(r: Rig) {
  const root = await parentRun(r);
  const openedLead = await root.api.open({ task: "lead the work", name: "lead" });
  assert.ok(openedLead.ok);
  const lead = await claimedChild(r, openedLead.sessionId);
  const openedLane = await lead.api.open({ task: "one lane", name: "lane" });
  assert.ok(openedLane.ok);
  const lane = await claimedChild(r, openedLane.sessionId);
  return { root, lead, lane };
}

test("a subagent whose own subagent still works reports in progress, then its final answer reaches the root", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
  const { root, lead, lane } = await delegatedTree(r);
  await r.runs.complete(root.run.id, root.leaseToken, { status: "ok", reply: "delegated" });
  await r.runs.complete(lead.run.id, lead.leaseToken, { status: "ok", reply: "started the lane" });

  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lead.run.id))!), true);
  const [progress] = await r.mailbox.pending(r.room.id);
  assert.match(progress!.text, /kind="in_progress"/);
  assert.match(progress!.text, /started the lane\n\nStill waiting on 1 subagent\./);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
  const listed = await r.syscallsFor(r.room).read({});
  assert.ok(listed.ok && listed.mode === "children");
  assert.equal(listed.children[0]!.activity.status, "waiting on subagents");
  await r.mailbox.acknowledge(r.room.id, [progress!.id]);

  await r.runs.complete(lane.run.id, lane.leaseToken, { status: "ok", reply: "lane result" });
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane.run.id))!), false);
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane.run.id))!), false);
  const leadWakes = await r.runs.inFlightForThread(lead.session.threadRef);
  assert.equal(leadWakes.length, 1);
  const leadWake = leadWakes[0]!;
  assert.equal(leadWake.dedupKey, `subagent-return:${lane.run.id}`);
  assert.equal(leadWake.request.delegatingRunId, lead.run.id);
  assert.equal(leadWake.request.sessionSenderId, lane.session.id);
  assert.equal(leadWake.request.conversation.threadRef, lead.session.threadRef);
  assert.match((await r.mailbox.pending(lead.session.id))[0]!.text, /lane result/);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);

  const woken = await r.runs.claimById(leadWake.id, "worker", 60_000);
  await r.mailbox.acknowledge(
    lead.session.id,
    (await r.mailbox.pending(lead.session.id)).map((mail) => mail.id),
  );
  await r.runs.complete(leadWake.id, woken!.leaseToken!, { status: "ok", reply: "final report" });
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane.run.id))!), true);
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(leadWake.id))!), false);
  const [final] = await r.mailbox.pending(r.room.id);
  assert.match(final!.text, /kind="final_answer"/);
  assert.match(final!.text, /final report/);
  const [rootWake] = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(rootWake!.dedupKey, `subagent-return:${leadWake.id}`);
  assert.equal(rootWake!.request.delegatingRunId, root.run.id);
  assert.equal(rootWake!.request.sessionSenderId, lead.session.id);
  assert.equal(rootWake!.request.conversation.threadRef, r.room.threadRef);
  const relisted = await r.syscallsFor(r.room).read({});
  assert.ok(relisted.ok && relisted.mode === "children");
  assert.deepEqual(relisted.children, []);
});

test("a result left unread while its parent subagent was busy keeps that subagent in progress until it is woken", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
  const { root, lead, lane } = await delegatedTree(r);
  await r.runs.complete(root.run.id, root.leaseToken, { status: "ok", reply: "delegated" });
  await r.runs.complete(lane.run.id, lane.leaseToken, { status: "ok", reply: "lane result" });
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane.run.id))!), false);
  assert.deepEqual(
    (await r.runs.inFlightForThread(lead.session.threadRef)).map((run) => run.id),
    [lead.run.id],
  );
  await r.runs.complete(lead.run.id, lead.leaseToken, { status: "ok", reply: "will report back" });
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lead.run.id))!), true);
  const [progress] = await r.mailbox.pending(r.room.id);
  assert.match(progress!.text, /kind="in_progress"/);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane.run.id))!), false);
  const [wake] = await r.runs.inFlightForThread(lead.session.threadRef);
  assert.equal(wake!.dedupKey, `subagent-return:${lane.run.id}`);
});

test("a subagent's wake starts a turn in its idle subagent parent; a read-only subagent only leaves mail", async () => {
  const r = await rig();
  const { lead, lane } = await delegatedTree(r);
  await r.runs.complete(lead.run.id, lead.leaseToken, { status: "ok", reply: "waiting" });
  const asked = await lane.api.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
  assert.ok(asked.ok);
  assert.deepEqual([asked.delivered, asked.busy], ["queued_turn", false]);
  const [wake] = await r.runs.inFlightForThread(lead.session.threadRef);
  assert.equal(wake!.request.delegatingRunId, lead.run.id);
  assert.equal(wake!.request.sessionSenderId, lane.session.id);

  const quiet = await rig();
  const tree = await delegatedTree(quiet);
  const opened = await tree.lead.api.open({ task: "read an untrusted page", readOnly: true });
  assert.ok(opened.ok);
  const reader = await claimedChild(quiet, opened.sessionId);
  await quiet.runs.complete(tree.lead.run.id, tree.lead.leaseToken, { status: "ok", reply: "waiting" });
  const out = await reader.api.write({ target: "parent", wake: true, text: "do the thing" });
  assert.ok(out.ok);
  assert.equal(out.delivered, "queued_message");
  assert.equal(out.notWoken, "a read-only subagent cannot start a turn in its parent");
  assert.deepEqual(await quiet.runs.inFlightForThread(tree.lead.session.threadRef), []);
});

test("a user stop above a subagent parent leaves its subagent's result as mail without waking it", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
  const { root, lead, lane } = await delegatedTree(r);
  await r.signals.send(root.run.id, { kind: "abort", reason: "by user" });
  await r.runs.complete(root.run.id, root.leaseToken, { status: "silent", stopped: true });
  await r.runs.complete(lead.run.id, lead.leaseToken, { status: "ok", reply: "lead done" });
  await r.runs.complete(lane.run.id, lane.leaseToken, { status: "ok", reply: "lane result" });
  assert.equal(await deliverSubagentMail(deps, (await r.runs.get(lane.run.id))!), true);
  assert.match((await r.mailbox.pending(lead.session.id))[0]!.text, /lane result/);
  assert.deepEqual(await r.runs.inFlightForThread(lead.session.threadRef), []);
});

test("a subagent's wake reaches its busy subagent parent through the mailbox and starts one turn when that turn ends", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
  const { lead, lane } = await delegatedTree(r);
  const asked = await lane.api.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
  assert.ok(asked.ok);
  assert.deepEqual([asked.delivered, asked.busy], ["queued_message", true]);
  assert.deepEqual(
    (await r.runs.inFlightForThread(lead.session.threadRef)).map((run) => run.id),
    [lead.run.id],
  );
  await r.runs.complete(lead.run.id, lead.leaseToken, { status: "ok", reply: "waiting for the lane" });
  const finished = (await r.runs.get(lead.run.id))!;
  assert.equal(await wakeForUnreadMail(deps, finished), "woken");
  assert.equal(await wakeForUnreadMail(deps, finished), "busy");
  const [wake] = await r.runs.inFlightForThread(lead.session.threadRef);
  assert.equal(wake!.request.delegatingRunId, lead.run.id);
  assert.equal(wake!.request.sessionSenderId, lane.session.id);
  assert.match((await r.mailbox.pending(lead.session.id))[0]!.text, /which region\?/);
});

test("a user stop suppresses a lane's pending wake even when the stopped run is not the one that delegated", async () => {
  for (const parentBusy of [true, false]) {
    const r = await rig();
    const first = await parentRun(r);
    const opened = await first.api.open({ task: "lane" });
    assert.ok(opened.ok);
    await r.runs.complete(first.run.id, first.leaseToken, { status: "ok", reply: "delegated" });
    const lane = await freshSession(r.sessions, opened.sessionId);
    const laneRun = (await r.runs.inFlightForThread(lane.threadRef))[0]!;
    await r.runs.claimById(laneRun.id, "worker", 60_000);
    const laneApi = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
      session: lane,
      scopeId: scope,
      request: { ...laneRun.request, runId: laneRun.id },
    });
    const second = parentBusy ? await parentRun(r) : undefined;
    const asked = await laneApi.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
    assert.equal(asked.ok && asked.delivered, parentBusy ? "queued_message" : "queued_turn");
    await stopSessionTree(r, r.room, USER_STOP_ALL);
    if (second)
      await r.runs.complete(second.run.id, second.leaseToken, {
        status: "silent",
        stopped: true,
      });
    assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
    const next = await parentRun(r);
    await r.runs.complete(next.run.id, next.leaseToken, { status: "ok", reply: "hi" });
    assert.equal(await wakeForUnreadMail({ ...r, maxAttempts: 3 }, (await r.runs.get(next.run.id))!), undefined);
    assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
    const [mail] = await r.mailbox.pending(r.room.id);
    assert.match(mail!.text, /which region\?/);
    assert.equal(mail!.wake, undefined);
  }
});

test("an undeliverable flagged message is settled without blocking the next one; a transient failure keeps the wake; a finished wake is settled", async () => {
  const r = await rig();
  const p = await parentRun(r);
  const opened = await p.api.open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const childRun = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await r.runs.claimById(childRun.id, "worker", 60_000);
  const childApi = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: child,
    scopeId: scope,
    request: { ...childRun.request, runId: childRun.id },
  });
  await r.mailbox.send({
    id: "poisoned",
    recipientId: r.room.id,
    senderId: child.id,
    actor: { id: "U9", type: "internal", displayName: "Sam" },
    audience: [],
    text: "from an audience the parent no longer matches",
    createdAt: 1,
    wake: true,
    senderRunId: childRun.id,
    delegatingRunId: p.run.id,
  });
  const asked = await childApi.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
  assert.equal(asked.ok && asked.delivered, "queued_message");
  await r.runs.complete(p.run.id, p.leaseToken, { status: "ok", reply: "done" });
  const finished = (await r.runs.get(p.run.id))!;
  const unavailable = {
    ...r.runs,
    enqueue: async () => {
      throw new Error("queue unavailable");
    },
  };
  await assert.rejects(wakeForUnreadMail({ ...r, runs: unavailable, maxAttempts: 3 }, finished), /queue unavailable/);
  assert.deepEqual(
    (await r.mailbox.pending(r.room.id)).map((mail) => Boolean(mail.wake)),
    [false, true],
  );
  assert.equal(await wakeForUnreadMail({ ...r, maxAttempts: 3 }, finished), "woken");
  const [poisoned, question] = await r.mailbox.pending(r.room.id);
  assert.deepEqual([poisoned!.id, poisoned!.wake], ["poisoned", undefined]);
  assert.ok(question!.wake);
  const wake = await r.runs.getByDedupKey(`subagent-followup:${question!.id}`);
  assert.ok(wake);
  const claimed = await r.runs.claimById(wake.id, "worker", 60_000);
  await r.runs.complete(wake.id, claimed!.leaseToken!, { status: "silent" });
  assert.equal(await wakeForUnreadMail({ ...r, maxAttempts: 3 }, (await r.runs.get(wake.id))!), undefined);
  assert.deepEqual(
    (await r.mailbox.pending(r.room.id)).map((mail) => mail.wake),
    [undefined, undefined],
  );
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
});

test("a child's result is still mailed when its originating run is gone", async () => {
  const r = await rig();
  const { run: origin } = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "slack", deliveryTarget: "D1", origin: { kind: "human" }, text: "go" },
  });
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { ...origin.request, runId: origin.id },
  });
  const opened = await api.open({ task: "work" });
  assert.ok(opened.ok);
  assert.ok(await r.runs.withdraw(origin.id));
  const child = await freshSession(r.sessions, opened.sessionId);
  const childRun = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claim = await r.runs.claimById(childRun.id, "worker", 60_000);
  await r.runs.complete(childRun.id, claim!.leaseToken!, { status: "ok", reply: "halfway" });
  assert.equal(await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(childRun.id))!), true);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
});

test("a failed enqueue after an interrupt says the run was stopped and the earlier message withdrawn", async () => {
  const roomy = await rig();
  const target = await runningChild(roomy, roomy.room, "watch");
  const failing = createSessionSyscalls({
    ...roomy,
    runs: {
      ...roomy.runs,
      enqueue: async () => {
        throw new Error("queue unavailable");
      },
    },
    maxAttempts: 3,
  }).forTurn({ session: roomy.room, scopeId: scope, request: { surface: "slack", conversation, actor } });
  await queuedMessage(roomy, target, roomy.room, "first");
  const out = await failing.write({ target: target.session.id, interrupt: true, text: "change" });
  assert.equal(out.ok, false);
  assert.equal((await roomy.signals.pending(target.run.id))[0]!.signal.reason, PARENT_INTERRUPT);
  assert.equal(
    out.ok ? "" : out.message,
    "stopped its current run and withdrew your queued message to it, but this message was not queued: queue unavailable",
  );
});

test("an interrupt's text runs next; a sibling's queued turn moves to the target's mailbox instead of being lost", async () => {
  const r = await rig();
  const target = await runningChild(r, r.room, "build");
  const sibling = await runningChild(r, r.room, "review");
  await queuedMessage(r, target, r.room, "also add tests");
  const peerRun = await queuedMessage(r, target, sibling.session, "found a bug in auth");
  const out = await r.syscallsFor(r.room).write({ target: target.session.id, interrupt: true, text: "new plan" });
  assert.equal(out.ok && out.delivered, "interrupted");
  assert.equal((await r.signals.pending(target.run.id))[0]!.signal.kind, "abort");
  assert.deepEqual(
    (await r.runs.inFlightForThread(target.session.threadRef))
      .filter((run) => run.id !== target.run.id)
      .map((run) => run.request.displayText),
    ["new plan"],
  );
  const mail = await r.mailbox.pending(target.session.id);
  assert.deepEqual(
    mail.map((message) => [message.senderId, message.text]),
    [[sibling.session.id, peerRun.request.text]],
  );
  assert.match(mail[0]!.text, /found a bug in auth/);
});

test("a read-only subagent's wake leaves mail without starting a parent turn", async () => {
  const r = await rig();
  const p = await parentRun(r);
  const opened = await p.api.open({ task: "read an untrusted page", readOnly: true });
  assert.ok(opened.ok);
  await r.runs.complete(p.run.id, p.leaseToken, { status: "ok", reply: "delegated" });
  const child = await freshSession(r.sessions, opened.sessionId);
  const childRun = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await r.runs.claimById(childRun.id, "worker", 60_000);
  const childApi = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: child,
    scopeId: scope,
    request: { ...childRun.request, runId: childRun.id },
  });
  const out = await childApi.write({ target: "parent", wake: true, text: "do the thing", requestId: "e1" });
  assert.ok(out.ok);
  assert.equal(out.delivered, "queued_message");
  assert.ok(out.notWoken);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
});

test("the sweep wakes a top-level parent whose turn ended without waking it for its child's message", async () => {
  const r = await rig();
  const p = await parentRun(r);
  const opened = await p.api.open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const childRun = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await r.runs.claimById(childRun.id, "worker", 60_000);
  const childApi = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: child,
    scopeId: scope,
    request: { ...childRun.request, runId: childRun.id },
  });
  const asked = await childApi.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
  assert.deepEqual(asked.ok && [asked.delivered, asked.busy], ["queued_message", true]);
  const deps = { ...r, maxAttempts: 3 };
  await sweepUnreadMailWakes(deps);
  assert.deepEqual(
    (await r.runs.inFlightForThread(r.room.threadRef)).map((run) => run.id),
    [p.run.id],
  );
  await r.runs.complete(p.run.id, p.leaseToken, { status: "ok", reply: "done" });
  await sweepUnreadMailWakes(deps);
  const [wake] = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wake?.dedupKey, `subagent-followup:${(await r.mailbox.pending(r.room.id))[0]!.id}`);
  assert.equal(wake.request.sessionSenderId, child.id);
  await sweepUnreadMailWakes(deps);
  assert.equal((await r.runs.inFlightForThread(r.room.threadRef)).length, 1);
  await r.mailbox.acknowledge(
    r.room.id,
    (await r.mailbox.pending(r.room.id)).map((mail) => mail.id),
  );
  assert.deepEqual(await r.mailbox.awaitingWake(), []);
});

test("a wake that found its parent busy starts one parent turn when that turn ends", async () => {
  const r = await rig();
  const p = await parentRun(r);
  const opened = await p.api.open({ task: "work" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const childRun = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  await r.runs.claimById(childRun.id, "worker", 60_000);
  const childApi = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: child,
    scopeId: scope,
    request: { ...childRun.request, runId: childRun.id },
  });
  const fyi = await childApi.write({ target: "parent", wake: false, text: "fyi" });
  assert.ok(fyi.ok);
  const asked = await childApi.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
  assert.ok(asked.ok);
  assert.deepEqual([asked.delivered, asked.busy], ["queued_message", true]);
  await r.runs.complete(p.run.id, p.leaseToken, { status: "ok", reply: "done" });
  const finished = (await r.runs.get(p.run.id))!;
  assert.equal(await wakeForUnreadMail({ ...r, maxAttempts: 3 }, finished), "woken");
  assert.equal(await wakeForUnreadMail({ ...r, maxAttempts: 3 }, finished), "busy");
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.request.delegatingRunId, p.run.id);
  assert.equal(wakes[0]!.request.sessionSenderId, child.id);
  const claimed = await r.runs.claimById(wakes[0]!.id, "worker", 60_000);
  await r.mailbox.acknowledge(
    r.room.id,
    (await r.mailbox.pending(r.room.id)).map((mail) => mail.id),
  );
  await r.runs.complete(wakes[0]!.id, claimed!.leaseToken!, { status: "silent" });
  assert.equal(await wakeForUnreadMail({ ...r, maxAttempts: 3 }, (await r.runs.get(wakes[0]!.id))!), undefined);
  const repeated = await childApi.write({ target: "parent", wake: true, text: "which region?", requestId: "q1" });
  assert.ok(repeated.ok);
  assert.deepEqual([repeated.delivered, repeated.busy], ["queued_message", false]);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
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
  const writer = { sessionId: child.id };
  await r.sessions.append(writer, { kind: "AgentMessage", text: "found 3 call sites" });

  const list = await syscalls.read({});
  assert.ok(list.ok && list.mode === "children");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0]!.title, "research_callers");
  assert.equal(list.children[0]!.activity.status, "pending");
  assert.match(list.children[0]!.lastSaid ?? "", /3 call sites/);

  const transcript = await syscalls.read({ target: "research_callers" });
  assert.ok(transcript.ok && transcript.mode === "transcript");
  assert.match(transcript.rendered, /found 3 call sites/);
});

test("read reports each child's latest tool step, last outcome, live descendants and unread mail", async () => {
  const r = await rig();
  const syscalls = r.syscallsFor(r.room);
  const children = new Map<string, Session>();
  for (const name of ["worker", "finisher", "stopper", "blocked", "failer", "delegator"]) {
    const out = await syscalls.open({ task: `task for ${name}`, name });
    assert.ok(out.ok);
    children.set(name, await freshSession(r.sessions, out.sessionId));
  }
  const claim = async (name: string) => {
    const session = children.get(name);
    assert.ok(session);
    const [queued] = await r.runs.inFlightForThread(session.threadRef);
    assert.ok(queued);
    const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
    assert.ok(claimed?.leaseToken);
    return { session, run: queued, leaseToken: claimed.leaseToken };
  };
  const step = (run: { session: Session; run: Run }, callId: string, tool: string, body: Record<string, unknown>) =>
    r.sessions.append({ sessionId: run.session.id }, { kind: "ToolCall", tool, callId, turnId: run.run.id, body });
  const grandchildOf = async (parent: Session, name: string, request: OrchestratorInput) => {
    const grandchild = await r.sessions.getOrCreateByThread(
      `agent:main:subagent:${name}`,
      "dm",
      scope,
      undefined,
      "slack",
    );
    await r.sessions.setParentSession(grandchild.id, parent.id);
    await r.runs.enqueue({ sessionId: grandchild.threadRef, request });
  };
  const working = await claim("worker");
  await step(working, "c1", "execute", { purpose: "Running tests" });
  await step(working, "c2", "files", {});
  await grandchildOf(working.session, "grandchild", working.run.request);
  await r.mailbox.send({
    id: "fyi-1",
    recipientId: working.session.id,
    senderId: r.room.id,
    actor,
    text: "fyi",
    audience: [actor],
    createdAt: Date.now(),
  });
  const finished = await claim("finisher");
  await step(finished, "f1", "execute", { purpose: "Writing the summary" });
  await r.runs.complete(finished.run.id, finished.leaseToken, { status: "ok", reply: "done" });
  const halted = await claim("stopper");
  await r.runs.complete(halted.run.id, halted.leaseToken, { status: "ok", reply: "", stopped: true });
  const blocked = await claim("blocked");
  await r.runs.complete(blocked.run.id, blocked.leaseToken, { status: "pending_approval" });
  const failed = await claim("failer");
  await r.runs.complete(failed.run.id, failed.leaseToken, { status: "failed", reason: "boom" });
  const delegated = await claim("delegator");
  await r.runs.complete(delegated.run.id, delegated.leaseToken, { status: "ok", reply: "handed off" });
  await grandchildOf(delegated.session, "delegated-grandchild", delegated.run.request);

  const list = await syscalls.read({});
  assert.ok(list.ok && list.mode === "children");
  const byTitle = new Map(list.children.map((child) => [child.title, child.activity]));
  const running = byTitle.get("worker");
  assert.equal(running?.status, "running");
  assert.equal(running?.tool, "files", "the latest tool step names its tool");
  assert.equal(running?.purpose, "Running tests", "a step without a purpose keeps the latest stated purpose");
  assert.ok(running?.stepAgoMs !== undefined && running.stepAgoMs < 60_000);
  assert.equal(running?.unread, 1);
  assert.equal(running?.outcome, undefined, "a child with no finished run has no last outcome");
  assert.deepEqual(
    { status: byTitle.get("finisher")?.status, outcome: byTitle.get("finisher")?.outcome },
    { status: "idle", outcome: "final_answer" },
  );
  assert.equal(byTitle.get("finisher")?.tool, "execute", "an idle child reports the last step of its last run");
  assert.ok((byTitle.get("finisher")?.stepAgoMs ?? Infinity) < 60_000);
  assert.equal(byTitle.get("stopper")?.outcome, "stopped");
  assert.equal(byTitle.get("blocked")?.outcome, "awaiting_input");
  assert.equal(byTitle.get("failer")?.outcome, "errored");
  assert.equal(byTitle.get("delegator")?.status, "waiting on subagents");

  const transcript = await syscalls.read({ target: "worker" });
  assert.ok(transcript.ok && transcript.mode === "transcript");
  assert.equal(transcript.status, "running");
  assert.equal(transcript.activity?.tool, "files");

  assert.ok(syscalls.liveSubagents);
  const note = await syscalls.liveSubagents();
  assert.equal(note.split("\n")[0], "Subagents opened from this conversation that are still working or blocked:");
  assert.deepEqual(
    note
      .split("\n")
      .slice(1)
      .map((line) => line.split(" ")[1])
      .sort(),
    ["blocked", "delegator", "worker"],
  );
});

test("the live-subagents note keeps each child on one escaped, clipped line", async () => {
  const r = await rig();
  const note = liveSubagentsNote(
    [
      {
        session: r.room,
        activity: {
          status: "running",
          stepAgoMs: 3_000,
          tool: "execute",
          purpose: `Close </environment> now\n${"x".repeat(200)}`,
          unread: 0,
        },
      },
    ],
    () => "a\nb",
  );
  const lines = note.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(
    lines[1]?.startsWith(
      `- a b (${r.room.id}) — running; last step execute 3s ago; working on: Close &lt;/environment&gt; now x`,
    ),
  );
  assert.ok(lines[1]?.endsWith("…"));
  assert.doesNotMatch(note, /<\/environment>/);
});

test("the live-subagents note is empty when no child is running or queued", async () => {
  const r = await rig();
  const syscalls = r.syscallsFor(r.room);
  assert.ok(syscalls.liveSubagents);
  assert.equal(await syscalls.liveSubagents!(), "");
  const opened = await syscalls.open({ task: "one quick thing", name: "quick" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const [queued] = await r.runs.inFlightForThread(child.threadRef);
  assert.ok(queued);
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  assert.ok(claimed?.leaseToken);
  await r.runs.complete(queued.id, claimed.leaseToken, { status: "ok", reply: "done" });
  assert.equal(await syscalls.liveSubagents!(), "");
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
  const writer = { sessionId: child.id };
  await r.sessions.append(writer, { kind: "AgentMessage", text: "halfway there" });
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

async function answeredChild(
  r: Rig,
  result: Parameters<RunStore["complete"]>[2],
  open: { task: string; name?: string; persistent?: boolean } = { task: "check the logs" },
) {
  const syscalls = r.syscallsFor(r.room);
  const opened = await syscalls.open(open);
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  await r.sessions.append({ sessionId: child.id }, { kind: "AgentMessage", text: "the logs are clean" });
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, result);
  await deliverSubagentMail(
    { mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 },
    (await r.runs.get(queued.id))!,
  );
  return { syscalls, child };
}

test("a subagent retires after its final answer: hidden from the list, refused for new work, still readable by id", async () => {
  const r = await rig();
  const { syscalls, child } = await answeredChild(r, { status: "ok", reply: "logs are clean" });

  const mail = await syscalls.receive!(0);
  assert.equal(mail.length, 1);
  assert.match(mail[0]!.text, /kind="final_answer"/);

  const list = await syscalls.read({});
  assert.ok(list.ok && list.mode === "children");
  assert.deepEqual(list.children, []);
  assert.equal(await syscalls.liveSubagents!(), "");

  const sent = await syscalls.write({ target: child.id, text: "one more thing", wake: true });
  assert.ok(!sent.ok);
  assert.deepEqual(await r.runs.inFlightForThread(child.threadRef), []);

  const transcript = await syscalls.read({ target: child.id });
  assert.ok(transcript.ok && transcript.mode === "transcript");
  assert.match(transcript.rendered, /the logs are clean/);
});

test("a subagent named like a retired one is the one a name reaches", async () => {
  const r = await rig();
  const { syscalls } = await answeredChild(r, { status: "ok", reply: "done" }, { task: "review", name: "reviewer" });
  const fresh = await syscalls.open({ task: "review again", name: "reviewer" });
  assert.ok(fresh.ok);
  const sent = await syscalls.write({ target: "reviewer", text: "also the tests", wake: true });
  assert.ok(sent.ok);
});

test("a silent subagent retires too", async () => {
  const r = await rig();
  const { syscalls } = await answeredChild(r, { status: "silent" });
  const list = await syscalls.read({});
  assert.ok(list.ok && list.mode === "children");
  assert.deepEqual(list.children, []);
});

test("a persistent subagent stays open after its final answer and takes follow-ups", async () => {
  const r = await rig();
  const { syscalls, child } = await answeredChild(
    r,
    { status: "ok", reply: "logs are clean" },
    { task: "operate the logs", persistent: true },
  );
  const list = await syscalls.read({});
  assert.ok(list.ok && list.mode === "children");
  assert.deepEqual(
    list.children.map((c) => c.sessionId),
    [child.id],
  );
  const sent = await syscalls.write({ target: child.id, text: "check again", wake: true });
  assert.ok(sent.ok);
  assert.equal(sent.delivered, "queued_turn");
});

test("a subagent that failed stays open so its parent can steer it", async () => {
  const r = await rig();
  const { syscalls, child } = await answeredChild(r, { status: "failed", reason: "boom" });
  const list = await syscalls.read({});
  assert.ok(list.ok && list.mode === "children");
  assert.deepEqual(
    list.children.map((c) => c.sessionId),
    [child.id],
  );
  const sent = await syscalls.write({ target: child.id, text: "try again", wake: true });
  assert.ok(sent.ok);
});

async function stoppedChildRun(r: Rig, said: string | undefined, result: Parameters<RunStore["complete"]>[2]) {
  const p = await parentRun(r);
  const opened = await p.api.open({ task: "trace the callers", name: "tracer" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  const writer = { sessionId: child.id, turnId: queued.id };
  await r.sessions.append({ sessionId: child.id }, { kind: "AgentMessage", text: "an older turn's reply" });
  const asked = await r.sessions.append(writer, { kind: "UserMessage", text: "trace the callers" });
  await r.runs.noteTurnUserSeq(queued.id, asked.seq);
  if (said) await r.sessions.append(writer, { kind: "AgentMessage", variant: "narration", text: said });
  await r.runs.complete(queued.id, claimed!.leaseToken!, result);
  return { parent: p, child, run: (await r.runs.get(queued.id))! };
}

test("a child stopped on its own mails its partial output and wakes its top-level parent", async () => {
  for (const stopScope of ["tree", "session", undefined] as const) {
    const r = await rig();
    const { parent, run } = await stoppedChildRun(r, "found 2 of 3 call sites so far", {
      status: "ok",
      reply: "",
      stopped: true,
      ...(stopScope ? { stopScope } : {}),
    });
    await r.runs.complete(parent.run.id, parent.leaseToken, { status: "ok", reply: "delegated" });
    await deliverSubagentMail({ ...r, maxAttempts: 3 }, run);
    const [mail] = await r.mailbox.pending(r.room.id);
    assert.match(mail!.text, /kind="stopped"/);
    assert.ok(mail!.text.includes(`Your subagent session "tracer" was stopped.`));
    assert.match(mail!.text, /<content>found 2 of 3 call sites so far<\/content>/);
    assert.deepEqual(
      (await r.runs.inFlightForThread(r.room.threadRef)).map((wake) => [wake.dedupKey, wake.request.displayText]),
      [[`subagent-return:${run.id}`, "Delegated task stopped"]],
    );
  }
});

test("a child stopped with its parent, or by its parent agent, leaves stopped mail without waking the parent", async () => {
  for (const stop of ["tree", "ancestor", "interrupt"] as const) {
    const r = await rig();
    const { parent, child, run } = await stoppedChildRun(r, undefined, { status: "silent" });
    const live = (await r.runs.enqueue({ sessionId: child.threadRef, request: run.request })).run;
    const claim = await r.runs.claimById(live.id, "w1", 60_000);
    if (stop === "tree") {
      await r.runs.complete(parent.run.id, parent.leaseToken, { status: "ok", reply: "delegated" });
      assert.ok(await stopSessionTree(r, r.room, "by user"));
      assert.equal((await r.signals.pending(live.id))[0]!.signal.scope, "ancestor");
    } else if (stop === "ancestor") {
      await r.signals.send(parent.run.id, { kind: "abort", reason: "by user" });
      await r.signals.send(live.id, { kind: "abort", reason: "by user" });
    } else {
      await r.runs.complete(parent.run.id, parent.leaseToken, { status: "ok", reply: "delegated" });
      assert.ok((await r.syscallsFor(r.room).write({ target: child.id, interrupt: true })).ok);
    }
    const stopScope = (await r.signals.pending(live.id))[0]!.signal.scope;
    await r.runs.complete(live.id, claim!.leaseToken!, {
      status: "silent",
      stopped: true,
      ...(stopScope ? { stopScope } : {}),
    });
    const deps = { ...r, maxAttempts: 3 };
    assert.equal(await deliverSubagentMail(deps, (await r.runs.get(live.id))!), true);
    const [mail] = await r.mailbox.pending(r.room.id);
    assert.match(mail!.text, /kind="stopped"/);
    const why = { tree: ` ${ANCESTOR_STOP}`, ancestor: "", interrupt: ` ${PARENT_INTERRUPT}` }[stop];
    assert.ok(mail!.text.includes(`was stopped${why}.`));
    assert.match(mail!.text, /<content>It stopped before saying anything\.<\/content>/);
    assert.deepEqual(
      (await r.runs.inFlightForThread(r.room.threadRef)).filter((wake) => wake.id !== parent.run.id),
      [],
    );
  }
});

test("a failed child's mail carries the failure reason and the last thing it said in that turn", async () => {
  const r = await rig();
  const { parent, child, run } = await stoppedChildRun(r, undefined, { status: "silent" });
  await r.runs.complete(parent.run.id, parent.leaseToken, { status: "ok", reply: "delegated" });
  const retry = (await r.runs.enqueue({ sessionId: child.threadRef, request: run.request })).run;
  const claim = await r.runs.claimById(retry.id, "w1", 60_000);
  const writer = { sessionId: child.id, turnId: retry.id };
  const asked = await r.sessions.append(writer, { kind: "UserMessage", text: "try again" });
  await r.runs.noteTurnUserSeq(retry.id, asked.seq);
  await r.sessions.append(writer, { kind: "AgentMessage", variant: "narration", text: "patched two of the files" });
  await r.runs.fail(retry.id, claim!.leaseToken!, "provider returned 500", { retry: false });
  await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(retry.id))!);
  const [mail] = await r.mailbox.pending(r.room.id);
  assert.match(mail!.text, /kind="errored"/);
  assert.ok(
    mail!.text.includes(
      "<content>provider returned 500\n\nLast output before the failure:\npatched two of the files</content>",
    ),
  );
  assert.doesNotMatch(mail!.text, /an older turn's reply/);
  assert.deepEqual(
    (await r.runs.inFlightForThread(r.room.threadRef)).map((wake) => wake.request.displayText),
    ["Delegated task failed"],
  );
});

test("stopped mail quotes only its own run's text that the whole parent audience can see, and forwards no files", async () => {
  const r = await rig();
  const other: Principal = { id: "U2", type: "internal", displayName: "Blair" };
  const both: Conversation = { ...conversation, audience: [actor, other] };
  await recordContext(r.sessions, r.room, { actor, conversation: both, surface: "slack", deliveryTarget: "D1" });
  await r.sessions.addParticipant(r.room.id, other.id);
  const { run: origin } = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: {
      actor,
      conversation: both,
      surface: "slack",
      deliveryTarget: "D1",
      origin: { kind: "human" },
      text: "go",
    },
  });
  await r.runs.claimById(origin.id, "worker", 60_000);
  const opened = await createSessionSyscalls({ ...r, maxAttempts: 3 })
    .forTurn({ session: r.room, scopeId: scope, request: { ...origin.request, runId: origin.id } })
    .open({ task: "summarize", name: "summarizer" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60_000);
  const writer = { sessionId: child.id, turnId: queued.id };
  const asked = await r.sessions.append(writer, { kind: "UserMessage", text: "summarize" });
  await r.runs.noteTurnUserSeq(queued.id, asked.seq);
  await r.sessions.append(writer, { kind: "AgentMessage", variant: "narration", text: "seen by both" });
  await r.sessions.append(writer, { kind: "AgentMessage", variant: "narration", text: "hidden from Blair" });
  await r.runs.complete(queued.id, claimed!.leaseToken!, {
    status: "ok",
    reply: "hidden from Blair",
    stopped: true,
    attachments: [{ name: "chart.png", blobId: "chart", mimetype: "image/png", sizeBytes: 1 }],
  });
  await r.sessions.append({ sessionId: child.id, turnId: randomUUID() }, { kind: "AgentMessage", text: "next turn" });
  const sessions = {
    ...r.sessions,
    visibleItems: async (...args: Parameters<SessionStore["visibleItems"]>) =>
      (await r.sessions.visibleItems(...args)).filter(
        (item) => args[1] !== other.id || item.text !== "hidden from Blair",
      ),
  };
  const deliveries = createDeliveryStore();
  await deliverSubagentMail({ ...r, sessions, deliveries, maxAttempts: 3 }, (await r.runs.get(queued.id))!);
  const [mail] = await r.mailbox.pending(r.room.id);
  assert.match(mail!.text, /<content>seen by both<\/content>/);
  assert.deepEqual(await deliveries.pending("slack"), []);
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

test("session reads show a late joiner the history from before they joined", async () => {
  const r = await rig();
  const target = await r.sessions.getOrCreateByThread("web:private-old", "dm", scope);
  const writer = { sessionId: target.id };
  await r.sessions.append(writer, { kind: "AgentMessage", text: "written-before-membership" });
  await r.sessions.addParticipant(target.id, actor.id);
  const view = await r.syscallsFor(r.room).read({ target: target.id });
  assert.ok(view.ok && view.mode === "transcript");
  assert.match(view.rendered, /written-before-membership/);
});

test("child runs retain the managed roster and read-only floor", async () => {
  const r = await rig();
  const tool = createSessionSyscalls({
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
    steerRun: r.steerRun,
    advisoryLock: r.advisoryLock,
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

test("a notebook-only turn's subagent stays notebook-only, and so do later turns woken into it", async () => {
  const r = await rig();
  const deps = {
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
    steerRun: r.steerRun,
    advisoryLock: r.advisoryLock,
    maxAttempts: 3,
  };
  const tidy = createSessionSyscalls(deps).forTurn({
    session: r.room,
    scopeId: scope,
    request: { surface: "cron", actor, conversation, memoryNotebookOnly: true },
  });
  const out = await tidy.open({ task: "check the notebook" });
  assert.ok(out.ok);
  const child = await freshSession(r.sessions, out.sessionId);
  assert.equal(child.spawnMeta?.memoryNotebookOnly, true);
  const [run] = await r.runs.inFlightForThread(child.threadRef);
  assert.equal(run!.request.memoryNotebookOnly, true);
  const claimed = await r.runs.claimById(run!.id, "worker", 60_000);
  await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const conversationTurn = createSessionSyscalls(deps).forTurn({
    session: r.room,
    scopeId: scope,
    request: { surface: "web", actor, conversation },
  });
  const queued = await conversationTurn.write({ wake: true, target: child.id, text: "check again" });
  assert.ok(queued.ok);
  assert.equal((await r.runs.inFlightForThread(child.threadRef))[0]!.request.memoryNotebookOnly, true);
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
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.dedupKey, `subagent-return:${pending!.id}`);
  assert.match(wakes[0]!.request.text, /Check internal messages/);
  assert.equal(wakes[0]!.request.surfaceTools, true);
  await r.mailbox.acknowledge(r.room.id, [`subagent-mail-${pending!.id}`]);
  assert.equal(
    await deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, pending!),
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
    deliverSubagentMail({ mailbox: r.mailbox, sessions: r.sessions, runs: r.runs, maxAttempts: 3 }, finished),
    /verified runtime context/,
  );
  await recordContext(r.sessions, destination, {
    actor,
    conversation: { ...conversation, threadRef: destination.threadRef },
    origin: { kind: "direct" },
    surface: "web",
    deliveryTarget: destination.threadRef,
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
  const original = {
    actor,
    conversation: { ...conversation, threadRef: target.threadRef },
    origin: { kind: "direct" as const },
    surface: "slack",
    deliveryTarget: "D-other",
    deliveryCandidates: [{ target: "D-other", label: "DM" }],
    surfaceTools: true,
    text: "original task",
  };
  await recordContext(r.sessions, target, original);
  const { run } = await r.runs.enqueue({ sessionId: target.threadRef, request: original });
  await r.runs.claimById(run.id, "worker", 60_000);
  const result = await r.syscallsFor(r.room).write({ target: target.id, text: "an intermediate update" });
  assert.ok(result.ok);
  assert.equal(result.delivered, "queued_message");
  assert.deepEqual(await r.signals.takePending(run.id), []);
  assert.equal((await r.runs.inFlightForThread(target.threadRef)).length, 1);
  const [mail] = await r.mailbox.pending(target.id);
  assert.match(mail!.text, /an intermediate update/);
  const woken = await r.syscallsFor(r.room).write({ target: target.id, text: "wake", wake: true });
  assert.ok(woken.ok);
  assert.deepEqual([woken.delivered, woken.busy, woken.notWoken], ["queued_message", true, undefined]);
  assert.deepEqual(await r.signals.takePending(run.id), []);
  assert.equal((await r.runs.inFlightForThread(target.threadRef)).length, 1);
});

async function webPeer(r: Rig, name: string, audience: Principal[] = [actor]): Promise<Session> {
  const peer = await r.sessions.getOrCreateByThread(`web:U1:${name}`, "dm", scope, undefined, "web");
  await r.sessions.updateTitle(peer.id, name);
  await r.sessions.addParticipant(peer.id, actor.id);
  return recordContext(r.sessions, peer, {
    actor,
    conversation: { kind: "dm", threadRef: peer.threadRef, audience },
    surface: "web",
    deliveryTarget: `web-${name}`,
  });
}

function peerApi(r: Rig, session: Session, extra: Partial<OrchestratorInput> = {}) {
  return createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session,
    scopeId: scope,
    request: {
      surface: "web",
      actor,
      conversation: { kind: "dm", threadRef: session.threadRef, audience: [actor] },
      ...extra,
    },
  });
}

test("a message to an idle peer conversation wakes it once, on the recipient's own context", async () => {
  const r = await rig();
  const sender = await webPeer(r, "planner");
  const target = await webPeer(r, "builder");
  const sent = await peerApi(r, sender).write({
    peer: true,
    wake: true,
    target: target.id,
    text: "please pick up the migration",
    requestId: "handoff",
  });
  assert.ok(sent.ok);
  assert.deepEqual([sent.delivered, sent.busy], ["queued_turn", false]);
  const [wake] = await r.runs.inFlightForThread(target.threadRef);
  assert.ok(wake);
  const [mail] = await r.mailbox.pending(target.id);
  assert.equal(wake.dedupKey, `subagent-followup:${mail!.id}`);
  assert.deepEqual([mail!.wake, mail!.peerDepth], [true, 1]);
  assert.match(mail!.text, /please pick up the migration/);
  assert.equal(wake.request.conversation.threadRef, target.threadRef);
  assert.equal(wake.request.deliveryTarget, "web-builder");
  assert.equal(wake.request.sessionSenderId, sender.id);
  assert.equal(wake.request.sessionMessageDepth, 1);
  assert.equal(wake.request.origin.kind, "automation");

  const retried = await peerApi(r, sender).write({
    peer: true,
    wake: true,
    target: target.id,
    text: "please pick up the migration",
    requestId: "handoff",
  });
  assert.ok(retried.ok);
  assert.equal((await r.runs.inFlightForThread(target.threadRef)).length, 1);
  assert.equal((await r.mailbox.pending(target.id)).length, 1);
});

test("a busy peer reads the message at its next step, or is woken once if its turn ends first", async () => {
  const r = await rig();
  const sender = await webPeer(r, "planner");
  const target = await webPeer(r, "builder");
  const busyTurn = async () => {
    const { run } = await r.runs.enqueue({
      sessionId: target.threadRef,
      request: { actor, conversation, surface: "web", origin: { kind: "human" }, text: "working" },
    });
    const claimed = await r.runs.claimById(run.id, "worker", 60_000);
    return { run, leaseToken: claimed!.leaseToken! };
  };
  const first = await busyTurn();
  const read = await peerApi(r, sender).write({ peer: true, wake: true, target: target.id, text: "fyi one" });
  assert.ok(read.ok);
  assert.deepEqual([read.delivered, read.busy, read.notWoken], ["queued_message", true, undefined]);
  assert.deepEqual(
    (await r.runs.inFlightForThread(target.threadRef)).map((run) => run.id),
    [first.run.id],
  );
  const delivered = await peerApi(r, target).receive!(0);
  assert.deepEqual(
    delivered.map((mail) => mail.peerDepth),
    [1],
  );
  await r.mailbox.acknowledge(
    target.id,
    delivered.map((mail) => mail.id),
  );
  await r.runs.complete(first.run.id, first.leaseToken, { status: "ok", reply: "done" });
  assert.equal(await wakeForUnreadMail({ ...r, maxAttempts: 3 }, (await r.runs.get(first.run.id))!), undefined);
  assert.deepEqual(await r.runs.inFlightForThread(target.threadRef), []);

  const second = await busyTurn();
  const unread = await peerApi(r, sender).write({ peer: true, wake: true, target: target.id, text: "fyi two" });
  assert.ok(unread.ok);
  await r.runs.complete(second.run.id, second.leaseToken, { status: "ok", reply: "done" });
  assert.equal(await wakeForUnreadMail({ ...r, maxAttempts: 3 }, (await r.runs.get(second.run.id))!), "woken");
  const [wake] = await r.runs.inFlightForThread(target.threadRef);
  assert.equal(wake?.request.sessionSenderId, sender.id);
  assert.equal(wake.request.conversation.threadRef, target.threadRef);
});

test("wake:false from an untitled conversation leaves attributed FYI mail and starts nothing", async () => {
  const r = await rig();
  const untitled = await r.sessions.getOrCreateByThread("web:U1:untitled", "dm", scope, undefined, "web");
  await r.sessions.addParticipant(untitled.id, actor.id);
  const sender = await recordContext(r.sessions, untitled, {
    actor,
    conversation: { kind: "dm", threadRef: untitled.threadRef, audience: [actor] },
    surface: "web",
  });
  const target = await webPeer(r, "builder");
  const fyi = await peerApi(r, sender).write({ peer: true, wake: false, target: target.id, text: "fyi" });
  assert.ok(fyi.ok);
  assert.deepEqual([fyi.delivered, fyi.busy, fyi.notWoken], ["queued_message", false, undefined]);
  assert.deepEqual(await r.runs.inFlightForThread(target.threadRef), []);
  const [mail] = await r.mailbox.pending(target.id);
  assert.deepEqual([mail!.wake, mail!.peerDepth], [undefined, undefined]);
  assert.ok(mail!.text.startsWith(`<subagent-message from="Untitled" fromSessionId="${sender.id}">`));
});

test("the restart sweep recovers a peer wake whose recipient was busy, once", async () => {
  const r = await rig();
  const sender = await webPeer(r, "planner");
  const target = await webPeer(r, "builder");
  const { run } = await r.runs.enqueue({
    sessionId: target.threadRef,
    request: { actor, conversation, surface: "web", origin: { kind: "human" }, text: "working" },
  });
  const claimed = await r.runs.claimById(run.id, "worker", 60_000);
  const sent = await peerApi(r, sender, { sessionMessageDepth: 3 }).write({
    peer: true,
    wake: true,
    target: target.id,
    text: "handoff",
  });
  assert.ok(sent.ok);
  assert.equal(sent.busy, true);
  const deps = { ...r, maxAttempts: 3 };
  await sweepUnreadMailWakes(deps);
  assert.deepEqual(
    (await r.runs.inFlightForThread(target.threadRef)).map((queued) => queued.id),
    [run.id],
  );
  await r.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  await sweepUnreadMailWakes(deps);
  await sweepUnreadMailWakes(deps);
  const wakes = await r.runs.inFlightForThread(target.threadRef);
  assert.equal(wakes.length, 1);
  const [mail] = await r.mailbox.pending(target.id);
  assert.equal(wakes[0]!.dedupKey, `subagent-followup:${mail!.id}`);
  assert.equal(wakes[0]!.request.sessionSenderId, sender.id);
  assert.equal(wakes[0]!.request.sessionMessageDepth, 4);
});

test("peer wakes stop after a chain of eight, and read-only or private turns only leave mail", async () => {
  const r = await rig();
  const sender = await webPeer(r, "planner");
  const target = await webPeer(r, "builder");
  const capped = await peerApi(r, sender, { sessionMessageDepth: 8 }).write({
    peer: true,
    wake: true,
    target: target.id,
    text: "ping",
  });
  assert.ok(capped.ok);
  assert.equal(capped.delivered, "queued_message");
  assert.match(capped.notWoken ?? "", /8 conversations already woke each other in a row/);
  const readOnly = await peerApi(r, sender, { readOnly: true }).write({
    peer: true,
    wake: true,
    target: target.id,
    text: "ping",
  });
  assert.ok(readOnly.ok);
  assert.match(readOnly.notWoken ?? "", /read-only turn cannot start work/);
  const privateTurn = await peerApi(r, sender, { privateSessionMessage: true, sessionMessageDepth: 1 }).write({
    peer: true,
    wake: true,
    target: target.id,
    text: "ping",
  });
  assert.ok(privateTurn.ok);
  assert.match(privateTurn.notWoken ?? "", /private turn/);
  assert.deepEqual(await r.runs.inFlightForThread(target.threadRef), []);
  assert.deepEqual(await r.mailbox.awaitingWake(), []);
  assert.equal((await r.mailbox.pending(target.id)).length, 3);
  const last = await peerApi(r, sender, { sessionMessageDepth: 7 }).write({
    peer: true,
    wake: true,
    target: target.id,
    text: "pong",
  });
  assert.ok(last.ok);
  assert.equal(last.delivered, "queued_turn");
  assert.equal((await r.runs.inFlightForThread(target.threadRef))[0]!.request.sessionMessageDepth, 8);
});

test("a peer wake cannot reach a conversation whose audience the sender cannot see", async () => {
  const r = await rig();
  const sender = await webPeer(r, "planner");
  const shared = await webPeer(r, "shared", [actor, { id: "U2", type: "internal", displayName: "Blake" }]);
  const out = await peerApi(r, sender).write({ peer: true, wake: true, target: shared.id, text: "hi" });
  assert.ok(!out.ok);
  assert.match(out.message, /outside the sender's authorized audience/);
  assert.deepEqual(await r.runs.inFlightForThread(shared.threadRef), []);
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
    steerRun: r.steerRun,
    advisoryLock: r.advisoryLock,
    maxAttempts: 3,
  }).forTurn({
    session: r.room,
    scopeId: scope,
    request: { actor, conversation, readOnly: true },
  });
  const refused = await api.write({ wake: true, target: child.id, text: "change things" });
  assert.ok(refused.ok);
  assert.deepEqual(await r.signals.takePending(run!.id), []);
  await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: "finished" });
  const queued = await api.write({ wake: true, target: child.id, text: "inspect only" });
  assert.ok(queued.ok);
  assert.equal((await r.runs.inFlightForThread(child.threadRef))[0]!.request.readOnly, true);
});

test("a notebook-only turn cannot start work in or interrupt a session that isn't notebook-only", async () => {
  const r = await rig();
  const deps = {
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
    steerRun: r.steerRun,
    advisoryLock: r.advisoryLock,
    maxAttempts: 3,
  };
  const opened = await r.syscallsFor(r.room).open({ task: "work" });
  assert.ok(opened.ok);
  const ordinary = await freshSession(r.sessions, opened.sessionId);
  const [run] = await r.runs.inFlightForThread(ordinary.threadRef);
  const claimed = await r.runs.claimById(run!.id, "worker", 60_000);
  const tidy = createSessionSyscalls(deps).forTurn({
    session: r.room,
    scopeId: scope,
    request: { surface: "cron", actor, conversation, memoryNotebookOnly: true },
  });
  const interrupted = await tidy.write({ interrupt: true, target: ordinary.id });
  assert.ok(!interrupted.ok);
  assert.match(interrupted.message, /notebook-only/);
  const steered = await tidy.write({ wake: true, target: ordinary.id, text: "change things" });
  assert.ok(steered.ok);
  assert.equal(steered.delivered, "queued_message");
  assert.deepEqual(await r.signals.takePending(run!.id), []);
  await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: "finished" });
  const woken = await tidy.write({ wake: true, target: ordinary.id, text: "change things" });
  assert.ok(woken.ok);
  assert.equal(woken.delivered, "queued_message");
  assert.match(woken.notWoken ?? "", /notebook-only/);
  assert.deepEqual(await r.runs.inFlightForThread(ordinary.threadRef), []);
  const own = await tidy.open({ task: "check the notebook" });
  assert.ok(own.ok);
  const child = await freshSession(r.sessions, own.sessionId);
  const [childRun] = await r.runs.inFlightForThread(child.threadRef);
  const childClaim = await r.runs.claimById(childRun!.id, "worker", 60_000);
  await r.runs.complete(childRun!.id, childClaim!.leaseToken!, { status: "ok", reply: "done" });
  const again = await tidy.write({ wake: true, target: child.id, text: "check again" });
  assert.ok(again.ok);
  assert.equal((await r.runs.inFlightForThread(child.threadRef))[0]!.request.memoryNotebookOnly, true);
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
    steerRun: r.steerRun,
    advisoryLock: r.advisoryLock,
    maxAttempts: 3,
    authorize: async (session) => session.id !== child.id,
  }).forTurn({ session: r.room, scopeId: scope, request: { actor, conversation } });
  assert.equal((await api.write({ target: child.id, text: "hello" })).ok, false);
  assert.deepEqual(await r.signals.takePending(run!.id), []);
});

test("a refused helper start names who was refused where", async () => {
  const r = await rig();
  const api = createSessionSyscalls({
    mailbox: r.mailbox,
    sessions: r.sessions,
    runs: r.runs,
    signals: r.signals,
    steerRun: r.steerRun,
    advisoryLock: r.advisoryLock,
    maxAttempts: 3,
    authorize: async () => false,
  }).forTurn({ session: r.room, scopeId: scope, request: { actor, conversation } });
  const opened = await api.open({ task: "work" });
  assert.equal(opened.ok, false);
  const message = opened.ok ? "" : opened.message;
  assert.ok(message.includes(actor.id) && message.includes(scope), message);
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
  assert.ok(await r.runs.getByDedupKey(`subagent-return:${run!.id}`));
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
    steerRun: r.steerRun,
    advisoryLock: r.advisoryLock,
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
  const woken = await privateCaller.write({ target: child.id, text: "wake", wake: true });
  assert.ok(woken.ok);
  assert.match(woken.notWoken ?? "", /private turn/);
  assert.equal((await r.runs.inFlightForThread(child.threadRef)).length, 1);
  assert.equal((await r.mailbox.pending(child.id)).length, 2);
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
    steerRun: r.steerRun,
    advisoryLock: r.advisoryLock,
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

test("retrying an unqueued child preserves detachment", async (t) => {
  const r = await rig();
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
  const retry = await r.syscallsFor(r.room).open(input);
  assert.ok(retry.ok);
  assert.equal(retry.sessionId, child.id);
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

test("follow-up retries recover the accepted run", async (t) => {
  const r = await rig();
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
  const request = { target: opened.sessionId, text: "more\u0000 work\ud800", wake: true, requestId: "stable" };
  assert.equal((await api.write(request)).ok, false);
  assert.equal((await api.write(request)).ok, true);
  assert.equal((await api.write({ ...request, text: "changed" })).ok, false);
  const child = await freshSession(r.sessions, opened.sessionId);
  assert.equal((await r.runs.inFlightForThread(child.threadRef)).length, 2);
});

test("mailbox survives recreation and rejects acknowledgements for another recipient", async () => {
  const backing = testMap<SessionMessage>();
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

test("an empty mailbox check skips sender validation and a delivered message still validates", async () => {
  const r = await rig();
  let checks = 0;
  const factory = createSessionSyscalls({
    ...r,
    maxAttempts: 3,
    enabled: async () => {
      checks++;
      return true;
    },
  });
  const api = factory.forTurn({ session: r.room, scopeId: scope, request: { actor, conversation } });
  assert.deepEqual(await api.receive!(), []);
  assert.equal(checks, 0);
  const one = await api.open({ task: "one", name: "one" });
  const two = await api.open({ task: "two", name: "two" });
  assert.ok(one.ok && two.ok);
  const sender = r.syscallsFor(await freshSession(r.sessions, one.sessionId));
  assert.equal((await sender.write({ target: "two", text: "shared finding" })).ok, true);
  const peer = factory.forTurn({
    session: await freshSession(r.sessions, two.sessionId),
    scopeId: scope,
    request: { actor, conversation },
  });
  checks = 0;
  const mail = await peer.receive!();
  assert.equal(mail.length, 1);
  assert.equal(checks, 1);
});

test("queued results recheck source-entry visibility after a participant leaves", async () => {
  const r = await rig();
  const other: Principal = { id: "U2", type: "internal" };
  const sharedScope = scopeId("group", "G1");
  const shared = await r.sessions.getOrCreateByThread("group:G1:mail-membership", "group", sharedScope);
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
  const writer = { sessionId: child.id };
  const entry = await r.sessions.append(writer, { kind: "AgentMessage", text: "OLD_PRIVATE_RESULT" });
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
  assert.equal((await r.sessions.visibleItems(child.id, other.id)).length, 0);
  assert.deepEqual(await api.receive!(), []);
  assert.equal((await r.mailbox.pending(shared.id)).length, 1);
});

test("coordinators and their children can delegate", async () => {
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
  await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(queued.id))!);
  const wake = (await r.runs.inFlightForThread(r.room.threadRef)).find((run) => run.id !== parent.run.id)!;
  assert.ok(wake);
  assert.equal(wake.request.surfaceTools, true);
  assert.equal(wake.request.deliveryTarget, undefined);
  assert.ok(wake.request.origin.kind === "automation");
  assert.deepEqual(wake.request.origin.destination, destination);
});

test("delegated automation retains owner-keychain authority", async () => {
  const r = await rig();
  const factory = createSessionSyscalls({ ...r, maxAttempts: 3 });
  const api = factory.forTurn({
    session: r.room,
    scopeId: scope,
    request: {
      actor,
      conversation,
      surface: "slack",
      origin: { kind: "automation", useOwnerKeychain: true },
    },
  });
  const opened = await api.open({ task: "prepare the scheduled report" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.ok(queued.request.origin.kind === "automation");
  assert.equal(queued.request.origin.useOwnerKeychain, true);
  const claimed = await r.runs.claimById(queued.id, "w1", 60000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok((await api.write({ target: child.id, text: "finish the report", wake: true })).ok);
  const followup = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.ok(followup.request.origin.kind === "automation");
  assert.equal(followup.request.origin.useOwnerKeychain, true);
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
    },
  });
  const opened = await privileged.open({ task: "scheduled report" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  assert.ok((await r.syscallsFor(r.room).write({ target: child.id, text: "unprivileged follow-up", wake: true })).ok);
  const next = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.ok(next.request.origin.kind === "automation");
  assert.equal(next.request.origin.useOwnerKeychain, undefined);
});

test("coordinator delegation follows the surface and excludes external actors", () => {
  const request = { surface: "slack", conversation };
  assert.equal(requiresDelegation(request), true);
  assert.equal(requiresDelegation({ ...request, surface: "web" }), false);
  assert.equal(requiresDelegation({ ...request, surface: "web", surfaceTools: true }), true);
  assert.equal(
    requiresDelegation({ ...request, conversation: { ...conversation, threadRef: "agent:main:subagent:test" } }),
    false,
  );
  assert.equal(
    requiresDelegation({
      ...request,
      surfaceOrigin: {
        audience: "external",
        workspace: "T2",
        author: { surface: "slack", account: "T2", id: "U9" },
        access: { companyDomains: [], companyTeamIds: [], serviceCredentials: [] },
      },
    }),
    false,
  );
  assert.equal(requiresDelegation({ ...request, swarm: { swarmId: "s1", messageId: "m1", recipientId: "w1" } }), false);
});

async function webChildRig() {
  const r = await rig();
  const webConversation: Conversation = { kind: "dm", threadRef: "web:alex:1", audience: [actor] };
  const room = await r.sessions.getOrCreateByThread(webConversation.threadRef, "dm", scope, undefined, "web");
  await r.sessions.addParticipant(room.id, actor.id);
  const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
    session: room,
    scopeId: scope,
    request: { surface: "web", conversation: webConversation, actor },
  });
  const opened = await api.open({ task: "inspect logs" });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const queued = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  const claimed = await r.runs.claimById(queued.id, "w1", 60000);
  await r.runs.complete(queued.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
  const deliver = async () => deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(queued.id))!);
  return { ...r, room, api, deliver, wakeKey: `subagent-return:${queued.id}` };
}

test("a finished child wakes an idle web parent without spine tools once", async () => {
  const r = await webChildRig();
  assert.equal(await r.deliver(), false);
  assert.equal(await r.deliver(), false);
  const wakes = await r.runs.inFlightForThread(r.room.threadRef);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.dedupKey, r.wakeKey);
  assert.equal(wakes[0]!.request.surfaceTools, undefined);
  assert.equal(wakes[0]!.request.actor.id, actor.id);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
});

test("a busy parent collects completion mail at its next tool boundary without an extra wake", async () => {
  const r = await webChildRig();
  const busy = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    dedupKey: "busy-parent",
    request: {
      actor,
      conversation: { kind: "dm", threadRef: r.room.threadRef, audience: [actor] },
      origin: { kind: "human" },
      text: "hi",
    },
  });
  assert.equal(await r.deliver(), false);
  assert.equal(await r.runs.getByDedupKey(r.wakeKey), null);
  const mail = await r.api.receive!(0);
  await r.api.acknowledge!(mail.map((message) => message.id));
  const claimed = await r.runs.claimById(busy.run.id, "w1", 60000);
  await r.runs.complete(busy.run.id, claimed!.leaseToken!, { status: "ok", reply: "hello" });
  assert.equal(await r.deliver(), true);
  assert.equal(await r.runs.getByDedupKey(r.wakeKey), null);
});

test("no wake once the parent already consumed the completion", async () => {
  const r = await webChildRig();
  assert.equal(await r.deliver(), false);
  await r.api.acknowledge!((await r.mailbox.pending(r.room.id)).map((message) => message.id));
  assert.equal(await r.deliver(), true);
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
  const opened = await api.open({ task: "inspect", persistent: true });
  assert.ok(opened.ok);
  const child = await freshSession(r.sessions, opened.sessionId);
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  return { ...r, parent: parent.run, child, run, api };
}

test("completion wakes run Slack parents as coordinators unless the author is external", async () => {
  const author = { surface: "slack", account: "T1", id: "U1" };
  for (const surfaceOrigin of [
    { audience: "internal" as const, workspace: "T1", author },
    {
      audience: "external" as const,
      workspace: "T1",
      author,
      access: { companyDomains: [], companyTeamIds: [], serviceCredentials: [] },
    },
  ]) {
    const r = await delegatedHumanRig({ surfaceOrigin });
    const claimed = await r.runs.claimById(r.run.id, "w1", 60000);
    await r.runs.complete(r.run.id, claimed!.leaseToken!, { status: "ok", reply: "done" });
    for (const pending of await r.runs.inFlightForThread(r.room.threadRef)) {
      const parentTurn = await r.runs.claimById(pending.id, "parent", 60_000);
      await r.runs.complete(pending.id, parentTurn!.leaseToken!, { status: "silent" });
    }
    await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(r.run.id))!);
    const wake = await r.runs.getByDedupKey(`subagent-return:${r.run.id}`);
    assert.ok(wake);
    assert.equal(wake.request.surfaceOrigin?.audience, surfaceOrigin.audience);
    assert.equal(wake.request.surfaceTools, surfaceOrigin.audience === "internal" ? true : undefined);
  }
});

test("a bound delegated follow-up does not overwrite its completed foreground response", async () => {
  const r = await delegatedHumanRig({
    surface: "web",
    idempotencyKey: "foreground-request",
    deliveryTarget: conversation.threadRef,
    deliveryWebhook: { binding: "bound-conversation", url: "https://receiver.example/qm" },
  });
  const parent = await r.runs.claimById(r.parent.id, "parent", 60_000);
  await r.runs.complete(r.parent.id, parent!.leaseToken!, { status: "ok", reply: "The delegated task is running." });
  const foreground = runResultDelivery((await r.runs.get(r.parent.id))!);
  assert.equal(foreground?.provenance.sourceRequestId, "foreground-request");
  const child = await r.runs.claimById(r.run.id, "child", 60_000);
  await r.runs.complete(r.run.id, child!.leaseToken!, { status: "ok", reply: "The delegated task finished." });
  await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(r.run.id))!);
  const wake = (await r.runs.getByDedupKey(`subagent-return:${r.run.id}`))!;
  const claimed = await r.runs.claimById(wake.id, "parent-followup", 60_000);
  await r.runs.complete(wake.id, claimed!.leaseToken!, { status: "ok", reply: "Here is the delegated result." });
  const completed = (await r.runs.get(wake.id))!;
  const followup = runResultDelivery(completed);
  assert.equal(followup?.provenance.sourceRequestId, undefined);
  assert.equal(followup?.provenance.sourceRunId, wake.id);
  assert.deepEqual(followup?.destination.webhook, {
    binding: "bound-conversation",
    url: "https://receiver.example/qm",
  });
  const continuation = runResultDelivery({
    ...completed,
    request: {
      ...completed.request,
      idempotencyKey: "followup-approval-request",
      approval: { requestId: "followup-approval", approved: true },
    },
  });
  assert.equal(continuation?.provenance.sourceRequestId, "followup-approval-request");
});

test("delegated human origin retains live authority boundaries", async () => {
  const r = await delegatedHumanRig();
  assert.equal(r.run.request.origin.kind, "human");
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
  assert.ok((await api.write({ target: r.child.id, text: "new scheduled task", wake: true })).ok);
  const next = (await r.runs.inFlightForThread(r.child.threadRef))[0]!;
  assert.equal(next.request.delegatingRunId, parent.run.id);
  assert.equal(await delegatedAuthorizationOrigin(next.request, r), undefined);
});

test("a subagent spawned by an owner's fire inherits the fire's automation authority", async () => {
  const r = await delegatedHumanRig({ origin: { kind: "automation", useOwnerKeychain: true, ownerFire: true } });
  assert.equal(r.run.request.origin.kind, "automation");
  assert.deepEqual(await delegatedAuthorizationOrigin(r.run.request, r), {
    kind: "automation",
    useOwnerKeychain: true,
    ownerFire: true,
  });
  await r.sessions.removeParticipant(r.run.request.sessionSenderId!, actor.id);
  assert.equal(
    (await delegatedAuthorizationOrigin(r.run.request, r))?.kind,
    "automation",
    "the delegating run, not a participant row, proves whose turn it was: a fire's thread has no participants",
  );
  await r.sessions.setParentSession(r.child.id, null);
  assert.equal(await delegatedAuthorizationOrigin(r.run.request, r), undefined);
});

test("a bot actor's automation turn, or one no trigger produced, delegates no authority to its subagents", async () => {
  const bot = await delegatedHumanRig({ origin: { kind: "automation", ownerFire: true }, botActor: true });
  assert.equal(bot.run.request.origin.kind, "automation");
  assert.equal(await delegatedAuthorizationOrigin(bot.run.request, bot), undefined);
  const unmarked = await delegatedHumanRig({ origin: { kind: "automation" } });
  assert.equal(await delegatedAuthorizationOrigin(unmarked.run.request, unmarked), undefined);
});

test("a later participant cannot change a completion's actor or destination", async () => {
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
  await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(queued.id))!);
  const wake = await r.runs.getByDedupKey(`subagent-return:${queued.id}`);
  assert.ok(wake);
  assert.equal(wake.request.actor.id, actor.id);
  assert.equal(wake.request.deliveryTarget, "slack:C1:task");
  assert.deepEqual(wake.request.origin, { kind: "human" });
});

for (const surface of ["slack", "web"] as const) {
  test(`${surface} completion wakes preserve live authorization for subsequent delegated steps`, async () => {
    const r = await delegatedHumanRig({ surface });
    const claimed = await r.runs.claimById(r.run.id, "w1", 60000);
    await r.runs.complete(r.run.id, claimed!.leaseToken!, { status: "ok", reply: "step one" });
    for (const pending of await r.runs.inFlightForThread(r.room.threadRef)) {
      const parentTurn = await r.runs.claimById(pending.id, "parent", 60_000);
      assert.ok(parentTurn);
      await r.runs.complete(pending.id, parentTurn.leaseToken!, { status: "silent" });
    }
    await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(r.run.id))!);
    const wake = (await r.runs.getByDedupKey(`subagent-return:${r.run.id}`))!;
    assert.ok(wake);
    assert.equal(wake.request.origin.kind, "human");
    assert.equal(wake.request.addressed, true);
    assert.equal((await delegatedAuthorizationOrigin(wake.request, r))?.kind, "human");
    const api = createSessionSyscalls({ ...r, maxAttempts: 3 }).forTurn({
      session: r.room,
      scopeId: scope,
      request: { ...wake.request, runId: wake.id },
    });
    assert.ok((await api.write({ target: r.child.id, text: "step two", wake: true })).ok);
    const next = (await r.runs.inFlightForThread(r.child.threadRef))[0]!;
    assert.equal((await delegatedAuthorizationOrigin(next.request, r))?.kind, "human");
    await r.sessions.setParentSession(r.child.id, null);
    assert.equal(await delegatedAuthorizationOrigin(wake.request, r), undefined);
    assert.equal(await delegatedAuthorizationOrigin(next.request, r), undefined);
  });
}

test("completed children leave only the working parent in flight and consumed returns settle", async () => {
  const r = await rig();
  const parent = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "slack", origin: { kind: "human" }, text: "work" },
  });
  await r.runs.claimById(parent.run.id, "parent", 60_000);
  const deps = { ...r, maxAttempts: 3 };
  for (let i = 0; i < 12; i++) {
    const opened = await r.syscallsFor(r.room).open({ task: `work ${i}` });
    assert.ok(opened.ok);
    const child = await freshSession(r.sessions, opened.sessionId);
    const [run] = await r.runs.inFlightForThread(child.threadRef);
    const claimed = await r.runs.claimById(run!.id, "child", 60_000);
    await r.runs.complete(run!.id, claimed!.leaseToken!, { status: "ok", reply: `result ${i}` });
    const finished = (await r.runs.get(run!.id))!;
    assert.equal(await deliverSubagentMail(deps, finished), false);
    assert.equal((await sessionTreeRuns(r.sessions, r.runs, r.room)).length, 1);
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
  assert.equal((await sessionTreeRuns(r.sessions, r.runs, r.room)).length, 1);
});

test("unread completions survive parent shutdown and share one pending wakeup", async () => {
  const r = await rig();
  const deps = { ...r, maxAttempts: 3 };
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
  const deps = { ...r, maxAttempts: 3 };
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
  const deps = { ...r, maxAttempts: 3 };
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
      thinkingLevel: "high",
      fastMode: false,
      skipMemory: true,
      turnWallClockMs: 120000,
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
    const parent = await r.runs.claimById(r.parent.id, "parent", 60000);
    await r.runs.complete(r.parent.id, parent!.leaseToken!, { status: "silent" });
    const child = await r.runs.claimById(r.run.id, "child", 60000);
    await r.runs.complete(r.run.id, child!.leaseToken!, { status: "ok", reply: "verified result" });
    const result = (await r.runs.get(r.run.id))!;
    await deliverSubagentMail({ ...r, maxAttempts: 3 }, result);
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
  const destinations = deliveryCandidatesFor(request, scope);
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
  const followup = await childApi.write({ target: grandchild.sessionId, wake: true, text: "late followup" });
  assert.equal(followup.ok, false);
  await r.runs.complete(run.id, claimed!.leaseToken!, { status: "ok", reply: "late result" });
  assert.equal(await deliverSubagentMail({ ...r, maxAttempts: 3 }, (await r.runs.get(run.id))!), true);
  assert.match((await r.mailbox.pending(r.room.id))[0]!.text, /late result/);
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
      await r.mailbox.acknowledge(parent.id, [mail[0]!.id]);
      await deliverSubagentMail(deps, completed);
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

test("children of a Slack group turn keep its source so external-workspace policy admits them", async () => {
  const { externalSlackRequestAllowed } = await import("../src/resolution/external-slack.ts");
  const { externalSlackNamespace } = await import("../src/slack/external-access.ts");
  const { slackSurfaceOrigin } = await import("../src/surfaces/slack/adapter.ts");
  const access = { companyDomains: ["partner.example"], companyTeamIds: ["TCOMPANY"], serviceCredentials: ["search"] };
  const policies = { ext: access };
  const admitted = (request: OrchestratorInput) =>
    externalSlackRequestAllowed({ ...request, surface: request.surface ?? "" }, policies);
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const factory = createSessionSyscalls({
    mailbox: createSessionMailbox(testMap<SessionMessage>()),
    sessions,
    runs,
    signals: createPostgresRunSignalStore(testDatabaseUrl()),
    steerRun: unexpectedSteer,
    advisoryLock: testAdvisoryLock(),
    maxAttempts: 3,
  });
  const cases = [
    {
      threadRef: "slack:group:G1",
      request: { surfaceOrigin: slackSurfaceOrigin({ accountId: "staff", teamId: "T1", userId: "U1" }) },
    },
    {
      threadRef: `${externalSlackNamespace("T2", access)}:C2`,
      request: {
        surfaceOrigin: slackSurfaceOrigin({ accountId: "ext", teamId: "T2", userId: "U1", external: access }),
      },
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
    assert.deepEqual(run!.request.surfaceOrigin, c.request.surfaceOrigin);
    const followed = await syscalls.write({ target: child.id, text: "more", wake: true });
    assert.ok(followed.ok, JSON.stringify(followed));
    const latest = (await runs.inFlightForThread(child.threadRef)).at(-1)!;
    assert.ok(admitted(latest.request));
    assert.deepEqual(latest.request.surfaceOrigin, run!.request.surfaceOrigin);
  }
});

test("sessions list shows only sidebar sessions the whole audience can see and create needs a live turn", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
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
    mailbox: createSessionMailbox(testMap<SessionMessage>()),
    sessions,
    runs,
    signals: createPostgresRunSignalStore(testDatabaseUrl()),
    steerRun: unexpectedSteer,
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

test("stopping a session tree tells its root who stopped it and its descendants that their parent was stopped", async () => {
  const sent: Array<{ runId: string; signal: unknown }> = [];
  const root = { id: "root", scopeId: "personal:a", threadRef: "web:root" } as unknown as Session;
  const child = { id: "child", scopeId: "personal:a", threadRef: "agent:main:subagent:child" } as unknown as Session;
  const stopped = await stopSessionTree(
    {
      sessions: { childrenOf: async (id: string) => (id === "root" ? [child] : []) },
      runs: {
        inFlightForThread: async (threadRef: string) =>
          [{ id: `run-${threadRef}`, status: "running" }] as unknown as Run[],
        withdraw: async () => true,
        get: async () => null,
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
      { kind: "abort", reason: ANCESTOR_STOP, scope: "ancestor" },
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
    const nested = (await r.runs.list({ threadRef: child.threadRef, limit: 1 }).then(([run]) => run))!;
    assert.equal(nested.request.origin.kind, origin.kind);
    assert.equal("messageTs" in nested.request.origin, false);
    assert.equal("entryTs" in nested.request.origin, false);
    assert.equal(nested.request.delegatingRunId, r.run.id);
    assert.equal(nested.request.sessionSenderId, r.child.id);
    assert.ok((await childApi.write({ target: child.id, wake: true, text: "inspect again" })).ok);
    const followup = (await r.runs.list({ threadRef: child.threadRef, limit: 1 }).then(([run]) => run))!;
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
  const run = (await r.runs.list({ threadRef: nested.threadRef, limit: 1 }).then(([run]) => run))!;
  assert.equal((await delegatedAuthorizationOrigin(run.request, r))?.kind, "human");
  await r.sessions.setParentSession(r.child.id, null);
  assert.equal(await delegatedAuthorizationOrigin(run.request, r), undefined);
});
