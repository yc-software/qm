import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTools, pauseStampAfterToolCall, type ToolContextRef } from "../src/agent/agent-tools.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createSessionSyscalls, sessionContextOf, type SessionSyscallDeps } from "../src/sessions/session-syscalls.ts";
import { returnSubagentRun, wakeForUnreadMail } from "../src/sessions/subagent-mail.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { testAdvisoryLock, testDatabaseUrl, testMap } from "./support/test-database.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { ToolResultScreen } from "../src/security/security-posture.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import type { Run } from "../src/runs/run-store.ts";

const actor: Principal = { id: "U1", type: "internal", displayName: "Alex" };
const scope = scopeId("personal", "U1");
const conversation: Conversation = { kind: "dm", threadRef: "slack:dm:D1", audience: [actor] };
const ANSWER = "the harbor ledger balances";

async function rig(awaiting = new Set<string>()) {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const { runs } = createPostgresRunStore(testDatabaseUrl());
  const signals = createPostgresRunSignalStore(testDatabaseUrl());
  const mailbox = createSessionMailbox(testMap<SessionMessage>(["recipientId", "wake"]));
  const advisoryLock = testAdvisoryLock();
  const steerRun: SessionSyscallDeps["steerRun"] = async (run, signal) => ({
    sent: await signals.send(run.id, signal),
  });
  const awaitingApproval = async (sessionId: string) => awaiting.has(sessionId);
  const deps = { mailbox, sessions, runs, signals, steerRun, advisoryLock, maxAttempts: 3, awaitingApproval };
  const factory = createSessionSyscalls(deps);
  const base = await sessions.getOrCreateByThread("slack:dm:D1", "dm", scope, undefined, "slack");
  const room = await sessions.getOrCreateByThread(
    base.threadRef,
    base.type,
    base.scopeId,
    undefined,
    undefined,
    undefined,
    {
      context: sessionContextOf({
        origin: { kind: "human" },
        surface: "slack",
        text: "",
        actor,
        conversation,
        deliveryTarget: "D1",
      }),
    },
  );
  await sessions.addParticipant(room.id, actor.id);
  return { ...deps, factory, room };
}
type Rig = Awaited<ReturnType<typeof rig>>;

async function parentTurn(r: Rig, screen?: (text: string) => ToolResultScreen["outcome"]) {
  const { run } = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: { actor, conversation, surface: "slack", deliveryTarget: "D1", origin: { kind: "human" }, text: "go" },
  });
  return turnOn(r, run, screen);
}

async function turnOn(
  r: Rig,
  run: Run,
  screen?: (text: string) => ToolResultScreen["outcome"],
  lease?: { leaseToken?: string | null },
) {
  const claimed = lease ?? (await r.runs.claimById(run.id, "worker", 60_000));
  const syscalls = r.factory.forTurn({ session: r.room, scopeId: scope, request: { ...run.request, runId: run.id } });
  const current = {
    sessionSyscalls: syscalls,
    read: async () => ({ content: "workspace data", sourceScopeId: "personal:U1" }),
  } as unknown as ToolContext;
  const ref: ToolContextRef = {
    current,
    scopeLabel: "personal:U1",
    orgScopeId: "org:default-org",
    replyOptional: true,
    pendingApprovals: [],
    emit: async () => undefined,
    screenToolResult: async (input) => ({ outcome: screen?.(input.result) ?? "allow" }),
  };
  const tools = createAgentTools(ref, { surfaceTools: true });
  const after = pauseStampAfterToolCall(ref);
  const exec = async (name: string, id: string, params: unknown) => {
    const tool = tools.find((t) => t.name === name)!;
    const result = (await (tool.execute as (...a: unknown[]) => Promise<unknown>)(
      id,
      params,
      undefined,
      undefined,
      {},
    )) as {
      content: Array<{ text?: string }>;
      terminate?: boolean;
    };
    return { result, text: result.content.map((c) => c.text ?? "").join("\n") };
  };
  const settle = async (id: string, result: { terminate?: boolean }) => {
    const stamp = await after({ toolCall: { id }, result });
    return stamp?.terminate ?? result.terminate ?? false;
  };
  const step = async (name: string, id: string, params: unknown) => {
    const out = await exec(name, id, params);
    return { ...out, terminate: await settle(id, out.result) };
  };
  const finish = (result: Parameters<Rig["runs"]["complete"]>[2]) =>
    r.runs.complete(run.id, claimed!.leaseToken!, result).then(async () => (await r.runs.get(run.id))!);
  return { run, ref, exec, settle, step, finish, syscalls, lease: claimed };
}

async function finishedHelper(r: Rig, sessionId: string) {
  const child = (await r.sessions.get(sessionId))!;
  const [queued] = await r.runs.inFlightForThread(child.threadRef);
  const claimed = await r.runs.claimById(queued!.id, "helper", 60_000);
  await r.runs.complete(queued!.id, claimed!.leaseToken!, { status: "ok", reply: ANSWER });
  return { child, run: (await r.runs.get(queued!.id))! };
}

async function sweep(r: Rig, helperRun: Run, ended?: Run) {
  const fresh = (await r.runs.get(helperRun.id))!;
  if ((await r.runs.pendingReturns()).some((run) => run.id === fresh.id))
    await returnSubagentRun(r, fresh).catch(() => undefined);
  if (ended) await wakeForUnreadMail(r, ended);
}

const followUps = async (r: Rig) =>
  (await r.runs.inFlightForThread(r.room.threadRef)).filter((run) => run.dedupKey?.startsWith("subagent-return:"));

async function oneFollowUpCarriesTheAnswer(r: Rig, helperRun: Run, endedParent: Run) {
  await sweep(r, helperRun, endedParent);
  await sweep(r, helperRun, endedParent);
  const wakes = await followUps(r);
  assert.equal(wakes.length, 1, "exactly one follow-up parent turn");
  assert.equal(wakes[0]!.dedupKey, `subagent-return:${helperRun.id}`);
  const wake = await turnOn(r, wakes[0]!);
  const read = await wake.step("subagents", "w1", { action: "wait", timeoutMs: 0 });
  assert.equal(read.terminate, false);
  assert.equal(read.text.split(ANSWER).length - 1, 1, "the follow-up sees the helper's answer once");
  const done = await wake.finish({ status: "ok", reply: `Report: ${ANSWER}` });
  await sweep(r, helperRun, done);
  await sweep(r, helperRun, done);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), [], "no further wake: no loop");
  assert.deepEqual(await r.mailbox.pending(r.room.id), []);
  assert.deepEqual(await r.runs.pendingReturns(), [], "the helper's return is settled");
}

test("a helper result that lands before finish_silently is not consumed by it and yields one follow-up turn", async () => {
  const r = await rig();
  const parent = await parentTurn(r);
  const opened = await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  assert.match(opened.text, /Opened subagent/);
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  await sweep(r, helper.run);
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1, "result is mailed while the parent is busy");
  assert.deepEqual(await followUps(r), []);
  const silent = await parent.step("finish_silently", "c2", { reason: "nothing to add" });
  assert.equal(silent.terminate, true);
  assert.doesNotMatch(silent.text, new RegExp(ANSWER), "a terminating result carries no mail");
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1, "the unread result survives the silent ending");
  const ended = await parent.finish({ status: "silent" });
  await oneFollowUpCarriesTheAnswer(r, helper.run, ended);
});

test("a helper result that lands after the parent ended silently yields one follow-up turn", async () => {
  const r = await rig();
  const parent = await parentTurn(r);
  await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  const silent = await parent.step("finish_silently", "c2", {});
  assert.equal(silent.terminate, true);
  const ended = await parent.finish({ status: "silent" });
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  await oneFollowUpCarriesTheAnswer(r, helper.run, ended);
});

test("mail in a sibling result that a later finish_silently turns terminal is never acknowledged", async () => {
  const r = await rig();
  const parent = await parentTurn(r);
  await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  await sweep(r, helper.run);
  const sibling = await parent.exec("files", "c2", { action: "read", path: "a.txt" });
  assert.match(sibling.text, new RegExp(ANSWER));
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1, "mail stays unread until its result is settled");
  const other = await parent.exec("files", "c4", { action: "read", path: "b.txt" });
  assert.doesNotMatch(other.text, new RegExp(ANSWER), "a parallel sibling does not carry the same mail");
  const silent = await parent.step("finish_silently", "c3", {});
  assert.equal(silent.terminate, true);
  assert.equal(await parent.settle("c2", sibling.result), true, "the sibling result is stamped terminal");
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1, "its mail stays unread for the follow-up");
  const ended = await parent.finish({ status: "silent" });
  await oneFollowUpCarriesTheAnswer(r, helper.run, ended);
});

test("an approval pause still ends the turn and leaves unread mail for later", async () => {
  const r = await rig();
  const parent = await parentTurn(r);
  await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  await sweep(r, helper.run);
  parent.ref.pausedOnApproval = true;
  const out = await parent.step("files", "c2", { action: "read", path: "a.txt" });
  assert.equal(out.terminate, true);
  assert.match(out.text, /workspace data/);
  assert.doesNotMatch(out.text, new RegExp(ANSWER));
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
});

test("a runtime handoff still ends the turn and leaves unread mail for the resumed runtime", async () => {
  const r = await rig();
  const parent = await parentTurn(r);
  await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  await sweep(r, helper.run);
  const out = await parent.step("context", "c2", { action: "compact", mode: "recent" });
  assert.equal(out.terminate, true);
  assert.ok(parent.ref.runtimeHandoff);
  assert.doesNotMatch(out.text, new RegExp(ANSWER));
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1);
});

test("a quarantined message ends the turn without acknowledging the clean mail beside it", async () => {
  const r = await rig();
  const parent = await parentTurn(r, (text) => (text.includes("tainted") ? "quarantine" : "allow"));
  await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  await sweep(r, helper.run);
  await r.mailbox.send({
    id: "tainted-note",
    recipientId: r.room.id,
    senderId: helper.child.id,
    actor,
    audience: [actor],
    text: "tainted note",
    createdAt: Date.now() + 1,
  });
  const out = await parent.step("files", "c2", { action: "read", path: "a.txt" });
  assert.equal(out.terminate, true);
  assert.equal(parent.ref.pausedOnApproval, true);
  assert.match(out.text, /quarantined pending human approval/);
  assert.doesNotMatch(out.text, new RegExp(ANSWER));
  assert.ok((await r.mailbox.pending(r.room.id)).some((m) => m.id === `subagent-mail-${helper.run.id}`));
});

test("ordinary delivery into a continuing turn is acknowledged once and starts no follow-up", async () => {
  const r = await rig();
  const parent = await parentTurn(r);
  await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  await sweep(r, helper.run);
  const out = await parent.step("files", "c2", { action: "read", path: "a.txt" });
  assert.equal(out.terminate, false);
  assert.equal(out.text.split(ANSWER).length - 1, 1);
  assert.deepEqual(await r.mailbox.pending(r.room.id), []);
  const ended = await parent.finish({ status: "ok", reply: `Report: ${ANSWER}` });
  await sweep(r, helper.run, ended);
  await sweep(r, helper.run, ended);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
});

test("helper mail that arrives during an approval pause starts no turn until the approval resolves, then shows once", async () => {
  const awaiting = new Set<string>();
  const r = await rig(awaiting);
  const parent = await parentTurn(r);
  await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  parent.ref.pausedOnApproval = true;
  const blocked = await parent.step("files", "c2", { action: "read", path: "a.txt" });
  assert.equal(blocked.terminate, true);
  awaiting.add(r.room.id);
  const paused = await parent.finish({ status: "ok", reply: "" });
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  for (let i = 0; i < 3; i++) await sweep(r, helper.run, paused);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), [], "no turn runs while the approval is pending");
  assert.equal((await r.mailbox.pending(r.room.id)).length, 1, "the answer waits unread");
  awaiting.delete(r.room.id);
  const { run: resume } = await r.runs.enqueue({
    sessionId: r.room.threadRef,
    request: {
      actor,
      conversation,
      surface: "slack",
      deliveryTarget: "D1",
      origin: { kind: "human" },
      text: "",
      approval: { requestId: "req-1", approved: true },
    },
  });
  const resumed = await turnOn(r, resume);
  const read = await resumed.step("subagents", "r1", { action: "wait", timeoutMs: 0 });
  assert.equal(read.text.split(ANSWER).length - 1, 1, "the resumed turn sees the answer once");
  const done = await resumed.finish({ status: "ok", reply: `Report: ${ANSWER}` });
  for (let i = 0; i < 3; i++) await sweep(r, helper.run, done);
  assert.deepEqual(await followUps(r), [], "no second delivery");
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), []);
  assert.deepEqual(await r.mailbox.pending(r.room.id), []);
  assert.deepEqual(await r.runs.pendingReturns(), []);
});

test("helper mail held by an approval pause yields exactly one follow-up once the approval is resolved without reading it", async () => {
  const awaiting = new Set<string>();
  const r = await rig(awaiting);
  const parent = await parentTurn(r);
  await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  await sweep(r, helper.run);
  parent.ref.pausedOnApproval = true;
  await parent.step("files", "c2", { action: "read", path: "a.txt" });
  awaiting.add(r.room.id);
  const paused = await parent.finish({ status: "ok", reply: "" });
  for (let i = 0; i < 3; i++) await sweep(r, helper.run, paused);
  assert.deepEqual(await followUps(r), [], "mail kept unread by the pausing result does not wake the paused turn");
  awaiting.delete(r.room.id);
  await oneFollowUpCarriesTheAnswer(r, helper.run, paused);
});

test("helper mail that arrives during a runtime handoff starts no turn and the resumed segment sees it once", async () => {
  const r = await rig();
  const parent = await parentTurn(r);
  await parent.step("subagents", "c1", { action: "open", task: "check the harbor ledger" });
  const handoff = await parent.step("context", "c2", { action: "compact", mode: "recent" });
  assert.equal(handoff.terminate, true);
  const helper = await finishedHelper(r, (await r.sessions.childrenOf(r.room.id))[0]!.id);
  for (let i = 0; i < 3; i++) await sweep(r, helper.run);
  assert.deepEqual(await followUps(r), [], "the handing-off run is still in flight, so no wake turn starts");
  const segment = await turnOn(r, parent.run, undefined, parent.lease!);
  const read = await segment.step("subagents", "s1", { action: "wait", timeoutMs: 0 });
  assert.equal(read.text.split(ANSWER).length - 1, 1, "the resumed segment sees the answer once");
  const done = await segment.finish({ status: "ok", reply: `Report: ${ANSWER}` });
  for (let i = 0; i < 3; i++) await sweep(r, helper.run, done);
  assert.deepEqual(await r.runs.inFlightForThread(r.room.threadRef), [], "no follow-up and no loop");
  assert.deepEqual(await r.mailbox.pending(r.room.id), []);
  assert.deepEqual(await r.runs.pendingReturns(), []);
});
