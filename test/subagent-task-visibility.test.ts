import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { sleep } from "../src/util/async.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Run } from "../src/runs/run-store.ts";

test("delegated tasks stay visible in the child; completion and automation wakes stay hidden", async (t) => {
  const built = buildApp(testConfig({ memoryCapture: "off" }));
  t.after(async () => {
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
  const threadRef = "dm:U1:subagent-visibility";
  const parent = await built.app.turn({
    surface: "test",
    surfaceTools: true,
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef },
    text: "hello",
  });
  assert.equal(parent.status, "ok", JSON.stringify(parent));
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
  const waitForRun = async (lookup: () => Promise<Run | null | undefined>) => {
    for (const deadline = Date.now() + 10_000; ; await sleep(25)) {
      const run = await lookup();
      if (run?.status === "done" || run?.status === "failed") {
        assert.equal(run.result?.status, "ok", JSON.stringify(run.result));
        return run;
      }
      assert.ok(Date.now() < deadline, "queued turn did not finish");
    }
  };
  const userEntry = async (run: Run) => {
    const session = (await built.sessions.getByThread(run.sessionId))!;
    const entries = await built.sessions.getEntries(session.id);
    const entry = entries.find((entry) => entry.type === "user" && entry.seq === run.turnUserSeq);
    assert.ok(entry, "run recorded a user entry");
    return entry.payload as { hidden?: boolean; display?: string };
  };
  const opened = await syscalls.open({ task: "Summarize the repo", name: "repo summary" });
  assert.ok(opened.ok);
  const child = (await built.sessions.get(opened.sessionId))!;
  built.runtime.startBackground();
  for (const task of ["Summarize the repo", "Check the tests too"]) {
    if (task === "Check the tests too") {
      const followup = await syscalls.write({ followup: true, target: child.id, text: task });
      assert.ok(followup.ok);
    }
    const run = await waitForRun(() => built.runs.latestForThread(child.threadRef));
    const entry = await userEntry(run);
    assert.notEqual(entry.hidden, true);
    assert.equal(entry.display, task);
    const wake = await waitForRun(() => built.runs.getByDedupKey(`subagent-return:${run.id}`));
    assert.equal((await userEntry(wake)).hidden, true, "parent completion wake stays hidden");
  }
  const { run: automation } = await built.runs.enqueue({
    sessionId: "cron:visibility",
    request: {
      ...parentRun.request,
      conversation: { ...parentRun.request.conversation, threadRef: "cron:visibility" },
      origin: { kind: "automation" },
      text: "Check for updates",
    },
  });
  assert.equal((await userEntry(await waitForRun(() => built.runs.get(automation.id)))).hidden, true);
});
