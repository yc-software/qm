import "./support/auto-fake-sprites.ts";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { TurnRequest } from "../src/types.ts";
import { isAgentReply, USER_ITEM_KINDS } from "../src/sessions/items.ts";
import { scopeId } from "../src/types.ts";
import { createMockAgent } from "./support/mock-agent.ts";

async function conversation(built: ReturnType<typeof buildApp>, threadRef: string, extra: Partial<TurnRequest> = {}) {
  await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    origin: { kind: "human" },
    text: "hello",
    ...extra,
  });
  const run = (await built.runs.list({ threadRef, limit: 1 }).then(([run]) => run))!;
  const session = (await built.sessions.getByThread(threadRef))!;
  const request = { ...run.request, runId: run.id };
  const bind = (extra: Partial<typeof request> = {}) =>
    built.sessionSyscalls.forTurn({ session, scopeId: session.scopeId, request: { ...request, ...extra } });
  return { run, session, bind, syscalls: bind() };
}

test("a subagent shows its delegated tasks while the parent's completion wake stays hidden", async () => {
  const built = buildApp(testConfig({ memoryCapture: "off" }));
  const { syscalls } = await conversation(built, "dm:U1:subagent-visibility", { surfaceTools: true });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const finished = async (lookup: () => Promise<Run | null | undefined>) => {
    let run: Run | null | undefined;
    await settle(async () => ["done", "failed"].includes((run = await lookup())?.status ?? ""));
    assert.equal(run?.result?.status, "ok", JSON.stringify(run?.result));
    return run!;
  };
  const userEntry = async (run: Run) => {
    const session = (await built.sessions.getByThread(run.sessionId))!;
    const items = await built.sessions.getItems(session.id);
    const { hidden, body } = items.find((item) => USER_ITEM_KINDS.includes(item.kind) && item.seq === run.turnUserSeq)!;
    assert.equal(body.speakerId, undefined, "delegated input is not a new human message");
    return { hidden: hidden === true, display: body.display as string | undefined };
  };

  const opened = await syscalls.open({ task: "Summarize the repo", name: "repo summary", persistent: true });
  assert.ok(opened.ok);
  const child = (await built.sessions.get(opened.sessionId))!;
  built.runtime.start();
  const first = await finished(() => built.runs.list({ threadRef: child.threadRef, limit: 1 }).then(([run]) => run));
  assert.equal(first.request.origin.kind, "human");
  assert.deepEqual(await userEntry(first), { hidden: false, display: "Summarize the repo" });
  const wake = await finished(() => built.runs.getByDedupKey(`subagent-return:${first.id}`));
  assert.equal((await userEntry(wake)).hidden, true);
  assert.equal(wake.request.origin.kind, "human");

  assert.ok((await syscalls.write({ wake: true, target: child.id, text: "Check the tests too" })).ok);
  const second = await finished(() => built.runs.list({ threadRef: child.threadRef, limit: 1 }).then(([run]) => run));
  assert.deepEqual(await userEntry(second), { hidden: false, display: "Check the tests too" });
});

test("a wake's reply in a web conversation replaces the agent's reply since the person last typed, for people with the flag", async () => {
  const built = buildApp(testConfig({ memoryCapture: "off" }));
  const threadRef = "web:U1:wake-rewrite";
  const dm = await conversation(built, threadRef, { surface: "web" });
  const { session } = dm;
  const peer = await conversation(built, "web:U1:wake-rewrite-peer", { surface: "web" });
  built.runtime.start();
  const latestRun = () => built.runs.list({ threadRef, limit: 1 }).then(([run]) => run);
  const lastReply = async (sessionId = session.id) =>
    (await built.sessions.getItems(sessionId)).findLast(isAgentReply)!;
  const replyTo = async (wake: () => Promise<Run | null | undefined>, sessionId?: string) => {
    await settle(async () => (await wake())?.status === "done");
    return lastReply(sessionId);
  };
  const subagentReply = async (parent = dm) => {
    const opened = await parent.syscalls.open({ task: "Summarize the repo" });
    assert.ok(opened.ok);
    const [task] = await built.runs.list({ threadRef: (await built.sessions.get(opened.sessionId))!.threadRef });
    return replyTo(() => built.runs.getByDedupKey(`subagent-return:${task!.id}`), parent.session.id);
  };

  const stacked = await subagentReply();
  assert.equal(stacked.body.supersedes, undefined, "flag off: the wake adds a message");
  await built.featureFlags.setEnabled("wake_reply_rewrite", scopeId("personal", "U1"), true, "test");
  const rewritten = await subagentReply();
  assert.equal(rewritten.body.supersedes, stacked.seq);
  assert.ok(rewritten.text!.includes(`"${stacked.text!.slice(0, 20)}`), "the model is told which message it replaces");

  assert.ok((await peer.syscalls.write({ wake: true, target: session.id, text: "take this over" })).ok);
  const fromPeer = async () => [await latestRun()].find((run) => run?.request.sessionSenderId === peer.session.id);
  assert.equal((await replyTo(fromPeer)).body.supersedes, rewritten.seq, "a handoff replaces the previous rewrite");

  await built.sessions.append(
    { sessionId: session.id },
    { kind: "UserMessage", text: "ok", body: { speakerId: "U1" } },
  );
  const afterTyping = await subagentReply();
  assert.equal(afterTyping.body.supersedes, undefined, "no reply since the person last typed, so nothing is replaced");

  const request = { ...(await latestRun())!.request, text: "!finish-silent" };
  const quiet = await built.runs.enqueue({ sessionId: threadRef, request });
  const silent = await replyTo(() => built.runs.get(quiet.run.id));
  assert.deepEqual([silent.text, silent.body.supersedes], [null, undefined], "ending silently replaces nothing");
  const kept = await subagentReply();
  assert.equal(kept.body.supersedes, afterTyping.seq, "the reply left in place is the one replaced");

  const turn = { surface: "web", actor: { externalId: "U1" }, origin: { kind: "human" as const }, text: "hello" };
  const fire = { ...turn, conversation: { kind: "dm" as const, threadRef }, surface: "monitor" };
  await built.app.turn({ ...fire, origin: { kind: "automation" } });
  assert.notEqual((await lastReply()).seq, kept.seq, "the watch fire posted its own reply");
  const report = { kind: "AgentMessage" as const, text: "nightly report", body: { via: "cron" } };
  await built.sessions.append({ sessionId: session.id, turnId: randomUUID() }, report);
  assert.equal(
    (await subagentReply()).body.supersedes,
    kept.seq,
    "a fire's reply and a delivered report are passed over",
  );

  const project = (await built.app.createProject("U1", "Launch"))!;
  await built.app.upsertDirectory([{ principalId: "U2", displayName: "Second", type: "internal" }]);
  await built.app.addProjectMember(project.id, "U1", "U2");
  const channelRef = project.scopeId.slice("group:".length);
  const chat = { kind: "group" as const, channelRef, threadRef: "web:U1:wake-rewrite-shared" };
  const shared = await conversation(built, chat.threadRef, { surface: "web", conversation: chat });
  const answer = await lastReply(shared.session.id);
  assert.equal((await subagentReply(shared)).body.supersedes, answer.seq, "a shared web chat is covered");
  const second = await conversation(built, chat.threadRef, {
    ...turn,
    conversation: chat,
    actor: { externalId: "U2" },
  });
  const theirs = await lastReply(shared.session.id);
  const added = await subagentReply(shared);
  assert.ok(added.seq > theirs.seq && added.body.supersedes === undefined, "a reply to someone else is not replaced");
  await built.app.turn({ ...turn, conversation: chat });
  const mine = await lastReply(shared.session.id);
  await built.featureFlags.setEnabled("wake_reply_rewrite", scopeId("personal", "U2"), true, "test");
  assert.equal((await subagentReply(second)).body.supersedes, undefined, "their wake leaves my reply alone");
  assert.equal((await subagentReply(shared)).body.supersedes, mine.seq, "my wake passes over their report");
});

test("a wake runs with a Slack bot's restrictions when either side does a bot's work, and never bot-flagged in a person's conversation", async () => {
  const note = "person-only note";
  const botTurns: unknown[] = [];
  const mock = createMockAgent();
  const runTurn: typeof mock.runTurn = async (turn) => {
    const syscalls = turn.tools.sessionSyscalls!;
    if (turn.botActor && turn.session.threadRef === "dm:U1:person")
      botTurns.push(await syscalls.write({ target: bot.session.id, text: JSON.stringify(turn.history) }));
    if (turn.input !== "what came back?") return mock.runTurn(turn);
    return { reply: JSON.stringify(await syscalls.receive!()), modelCalls: 1 };
  };
  const built = buildApp(testConfig({ memoryCapture: "off" }), { agent: { ...mock, runTurn } });
  const person = await conversation(built, "dm:U1:person");
  await conversation(built, "dm:U1:person", { text: note });
  const bot = await conversation(built, "dm:U1:bot", { botActor: true });
  const other = await conversation(built, "dm:U1:other");
  const spare = await conversation(built, "dm:U1:spare");
  const asBot = person.bind({ botActor: true });
  for (const [sender, target] of [
    [person.syscalls, bot],
    [person.syscalls, other],
    [bot.bind({ botActor: undefined, sessionSenderId: person.session.id }), spare],
  ] as const)
    assert.ok((await sender.write({ wake: true, target: target.session.id, text: "take this over" })).ok);
  const opened = await asBot.open({ task: "summarize the log" });
  assert.ok(opened.ok);
  const child = (await built.sessions.get(opened.sessionId))!;
  const [task] = await built.runs.list({ threadRef: child.threadRef, limit: 1 });
  assert.ok(await built.runs.withdraw(task!.id));
  assert.ok((await person.syscalls.write({ wake: true, target: child.id, text: "and the warnings?" })).ok);
  const [run] = await built.runs.list({ threadRef: child.threadRef, limit: 1 });
  assert.deepEqual([child.spawnMeta?.botActor, run!.request.botActor], [true, undefined]);
  const claim = await built.runs.claimById(run!.id, "worker", 60_000);
  await built.runs.complete(run!.id, claim!.leaseToken!, { status: "ok", reply: "done" });
  await settle(async () => !!(await built.runs.getByDedupKey(`subagent-return:${run!.id}`)));
  const wakes = [bot, other, spare, person].map(({ session }) => built.runs.inFlightForThread(session.threadRef));
  const marks = (await Promise.all(wakes)).map(([wake]) => wake!.request.botActor);
  assert.deepEqual(marks, [true, undefined, undefined, true]);
  const { session: fork, bind } = await conversation(built, "dm:U1:fork");
  await built.sessions.updateForkProvenance(fork.id, { forkedFrom: { sessionId: child.id }, forkBoundarySeq: 1 });
  assert.ok((await bind({ botActor: true }).open({ task: "check the fork" })).ok);
  built.runtime.start();
  let wake: Run | null | undefined;
  await settle(async () => (wake = await built.runs.getByDedupKey(`subagent-return:${run!.id}`))?.status === "done");
  assert.equal(JSON.stringify(await bot.syscalls.receive!()).includes(note), false, "bot work reads the person's note");
  assert.deepEqual([wake!.result?.status, botTurns], ["silent", []]);
  const next = await conversation(built, "dm:U1:person", { text: "what came back?" });
  assert.ok(next.run.result?.reply?.includes(child.id), next.run.result?.reply);
  const forkRuns = () => built.runs.list({ threadRef: fork.threadRef, limit: 1 });
  await settle(async () => !!(wake = (await forkRuns())[0])?.request.sessionSenderId && wake?.status === "done");
  assert.equal(wake!.result?.status, "ok");
});

test("human-origin delegated input is screened before model execution", async () => {
  const screened: string[] = [];
  const built = buildApp(testConfig({ memoryCapture: "off", securityPosture: "strict" }), {
    securityScreener: {
      provider: "test-screen",
      async classify(input) {
        screened.push(input.payload);
        return {
          score: 1,
          threshold: 0.5,
          verdict: input.payload.includes("UNTRUSTED_TASK")
            ? { decision: "strict", reason: "test block" }
            : { decision: "auto" },
        };
      },
    },
  });
  const { syscalls } = await conversation(built, "dm:U1:screen-delegation", { text: "inspect a task" });
  const opened = await syscalls.open({ task: "UNTRUSTED_TASK" });
  assert.ok(opened.ok);
  const child = (await built.sessions.get(opened.sessionId))!;
  const run = (await built.runs.list({ threadRef: child.threadRef, limit: 1 }).then(([run]) => run))!;
  assert.equal(run.request.origin.kind, "human");
  built.runtime.start();
  await settle(async () => ["done", "failed"].includes((await built.runs.get(run.id))!.status));
  assert.equal((await built.runs.get(run.id))!.result?.status, "pending_approval");
  assert.ok(screened.some((payload) => payload.includes("session-delegation") && payload.includes("UNTRUSTED_TASK")));
});

for (const fork of [false, true]) {
  test(`a human-initiated ${fork ? "fork" : "new session"} shows its seed without claiming human authorship`, async () => {
    const { startSession } = await import("../src/api/start-session.ts");
    const built = buildApp(testConfig({ memoryCapture: "off" }));
    const { run: parent, session } = await conversation(built, `web:U1:seed-${fork}`, {
      surface: "web",
      text: "start another task",
    });
    await built.config.setPersonalModelAuth("U1", true, "openai");
    const out = await startSession(built.app, built.sessions, "U1", {
      scopeId: session.scopeId,
      ...(fork ? { forkOf: session.id } : {}),
      text: "work on the seed",
      origin: parent.request.origin,
      sessionSenderId: session.id,
      delegatingRunId: parent.id,
    });
    assert.ok("session" in out);
    const queued = (await built.runs.list({ threadRef: out.session.threadRef, limit: 1 }).then(([run]) => run))!;
    assert.equal(queued.request.modelAccount, "company");
    built.runtime.start();
    await settle(async () => (await built.runs.get(queued.id))!.status === "done");
    const run = (await built.runs.get(queued.id))!;
    assert.equal(run.result?.status, "ok");
    const item = (await built.sessions.getItems(out.session.id)).find((item) => item.seq === run.turnUserSeq)!;
    assert.equal(item.hidden === true, false);
    assert.equal(item.body.speakerId, undefined);
    assert.equal(item.text, "work on the seed");
  });
}
