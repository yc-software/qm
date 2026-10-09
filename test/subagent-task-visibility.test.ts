import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
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
  });
  const parentRun = (await built.runs.latestForThread(threadRef))!;
  const parentSession = (await built.sessions.getByThread(threadRef))!;
  await built.featureFlags.setEnabled("responsive_spine", parentSession.scopeId, true, "U1");
  const syscalls = createSessionSyscalls({
    sessions: built.sessions,
    runs: built.runs,
    signals: built.signals,
    mailbox: createSessionMailbox(createMemoryMap<SessionMessage>()),
    maxAttempts: 1,
  }).forTurn({ session: parentSession, scopeId: parentSession.scopeId, request: parentRun.request });
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
    const { hidden, display } = payload as { hidden?: boolean; display?: string };
    return { hidden: hidden === true, display };
  };

  const opened = await syscalls.open({ task: "Summarize the repo", name: "repo summary" });
  assert.ok(opened.ok);
  const child = (await built.sessions.get(opened.sessionId))!;
  built.runtime.startBackground();
  const first = await finished(() => built.runs.latestForThread(child.threadRef));
  assert.deepEqual(await userEntry(first), { hidden: false, display: "Summarize the repo" });
  const wake = await finished(() => built.runs.getByDedupKey(`subagent-return:${first.id}`));
  assert.equal((await userEntry(wake)).hidden, true);

  assert.ok((await syscalls.write({ followup: true, target: child.id, text: "Check the tests too" })).ok);
  const second = await finished(() => built.runs.latestForThread(child.threadRef));
  assert.deepEqual(await userEntry(second), { hidden: false, display: "Check the tests too" });
});
