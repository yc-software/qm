import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { TurnRequest } from "../src/types.ts";
import { USER_ITEM_KINDS } from "../src/sessions/items.ts";

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
  const bind = (extra: { botActor?: true } = {}) =>
    built.sessionSyscalls.forTurn({ session, scopeId: session.scopeId, request: { ...request, ...extra } });
  return { run, session, bind, syscalls: bind() };
}

test("a subagent shows its delegated tasks while the parent's completion wake stays hidden", async (t) => {
  const built = buildApp(testConfig({ memoryCapture: "off" }));
  t.after(async () => {
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
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

test("a wake runs with a Slack bot's restrictions when either the woken conversation or its sender does a bot's work", async () => {
  const built = buildApp(testConfig({ memoryCapture: "off" }));
  const person = await conversation(built, "dm:U1:person");
  const bot = await conversation(built, "dm:U1:bot", { botActor: true });
  const other = await conversation(built, "dm:U1:other");
  const asBot = person.bind({ botActor: true });
  for (const [sender, target] of [
    [person.syscalls, bot],
    [person.syscalls, other],
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
  const wakes = [bot, other, person].map(({ session }) => built.runs.inFlightForThread(session.threadRef));
  const marks = (await Promise.all(wakes)).map(([wake]) => wake!.request.botActor);
  assert.deepEqual(marks, [true, undefined, true]);
});

test("human-origin delegated input is screened before model execution", async (t) => {
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
  t.after(async () => {
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
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
  test(`a human-initiated ${fork ? "fork" : "new session"} shows its seed without claiming human authorship`, async (t) => {
    const { startSession } = await import("../src/api/start-session.ts");
    const built = buildApp(testConfig({ memoryCapture: "off" }));
    t.after(async () => {
      built.scheduler.stop();
      built.deploymentLayerRefresh.stop();
      await built.runtime.stop();
    });
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
