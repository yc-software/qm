import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Run } from "../src/runs/run-store.ts";

test("a subagent shows its delegated tasks while the parent's completion wake stays hidden", async (t) => {
  const built = buildApp(testConfig({ memoryCapture: "off" }));
  t.after(async () => {
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
  const threadRef = "dm:U1:subagent-visibility";
  await built.app.turn({
    surface: "test",
    surfaceTools: true,
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "hello",
    origin: { kind: "human" },
  });
  const parentRun = (await built.runs.latestForThread(threadRef))!;
  const parentSession = (await built.sessions.getByThread(threadRef))!;
  await built.config.setPersonalModelAuth("U1", true, "openai");
  await built.featureFlags.setEnabled("responsive_spine", parentSession.scopeId, true, "U1");
  const syscalls = createSessionSyscalls({
    sessions: built.sessions,
    runs: built.runs,
    signals: built.signals,
    mailbox: createSessionMailbox(createMemoryMap<SessionMessage>()),
    maxAttempts: 1,
  }).forTurn({
    session: parentSession,
    scopeId: parentSession.scopeId,
    request: { ...parentRun.request, runId: parentRun.id },
  });
  const finished = async (lookup: () => Promise<Run | null | undefined>) => {
    let run: Run | null | undefined;
    await settle(async () => ["done", "failed"].includes((run = await lookup())?.status ?? ""));
    assert.equal(run?.result?.status, "ok", JSON.stringify(run?.result));
    return run!;
  };
  const userEntry = async (run: Run) => {
    const session = (await built.sessions.getByThread(run.sessionId))!;
    const entries = await built.sessions.getEntries(session.id);
    const { payload } = entries.find((entry) => entry.type === "user" && entry.seq === run.turnUserSeq)!;
    const { hidden, display, speakerId } = payload as { hidden?: boolean; display?: string; speakerId?: string };
    assert.equal(speakerId, undefined, "delegated input is not a new human message");
    return { hidden: hidden === true, display };
  };

  const opened = await syscalls.open({ task: "Summarize the repo", name: "repo summary" });
  assert.ok(opened.ok);
  const child = (await built.sessions.get(opened.sessionId))!;
  built.runtime.startBackground();
  const first = await finished(() => built.runs.latestForThread(child.threadRef));
  assert.equal(first.request.origin.kind, "human");
  assert.deepEqual(await userEntry(first), { hidden: false, display: "Summarize the repo" });
  const wake = await finished(() => built.runs.getByDedupKey(`subagent-return:${first.id}`));
  assert.equal((await userEntry(wake)).hidden, true);
  assert.equal(wake.request.origin.kind, "human");

  assert.ok((await syscalls.write({ followup: true, target: child.id, text: "Check the tests too" })).ok);
  const second = await finished(() => built.runs.latestForThread(child.threadRef));
  assert.deepEqual(await userEntry(second), { hidden: false, display: "Check the tests too" });
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
  const threadRef = "dm:U1:screen-delegation";
  await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    origin: { kind: "human" },
    text: "inspect a task",
  });
  const parent = (await built.runs.latestForThread(threadRef))!;
  const session = (await built.sessions.getByThread(threadRef))!;
  const syscalls = createSessionSyscalls({
    sessions: built.sessions,
    runs: built.runs,
    signals: built.signals,
    mailbox: createSessionMailbox(createMemoryMap<SessionMessage>()),
    maxAttempts: 1,
  }).forTurn({ session, scopeId: session.scopeId, request: { ...parent.request, runId: parent.id } });
  const opened = await syscalls.open({ task: "UNTRUSTED_TASK" });
  assert.ok(opened.ok);
  const child = (await built.sessions.get(opened.sessionId))!;
  const run = (await built.runs.latestForThread(child.threadRef))!;
  assert.equal(run.request.origin.kind, "human");
  built.runtime.startBackground();
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
    const threadRef = `web:U1:seed-${fork}`;
    await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      origin: { kind: "human" },
      text: "start another task",
    });
    const parent = (await built.runs.latestForThread(threadRef))!;
    const session = (await built.sessions.getByThread(threadRef))!;
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
    const queued = (await built.runs.latestForThread(out.session.threadRef))!;
    assert.equal(queued.request.modelAccount, "company");
    built.runtime.startBackground();
    await settle(async () => (await built.runs.get(queued.id))!.status === "done");
    const run = (await built.runs.get(queued.id))!;
    assert.equal(run.result?.status, "ok");
    const entry = (await built.sessions.getEntries(out.session.id)).find((entry) => entry.seq === run.turnUserSeq)!;
    const payload = entry.payload as { hidden?: boolean; speakerId?: string; text?: string };
    assert.equal(payload.hidden === true, false);
    assert.equal(payload.speakerId, undefined);
    assert.equal(payload.text, "work on the seed");
  });
}
