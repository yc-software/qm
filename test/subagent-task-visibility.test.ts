import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { sleep } from "../src/util/async.ts";

test("a delegated subagent task stays visible in the child transcript; other automated prompts stay hidden", async (t) => {
  const built = buildApp(testConfig({ memoryCapture: "off" }));
  t.after(async () => {
    built.scheduler.stop();
    await built.runtime.stop();
  });
  const parent = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:subagent-visibility" },
    text: "hello",
  });
  assert.equal(parent.status, "ok", JSON.stringify(parent));
  const parentRun = (await built.runs.latestForThread("dm:U1:subagent-visibility"))!;
  const parentSession = (await built.sessions.getByThread("dm:U1:subagent-visibility"))!;
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:visibility", "dm", parentSession.scopeId);
  await built.sessions.setParentSession(child.id, parentSession.id);
  await built.sessions.setSpawnMeta(child.id, {
    actor: parentRun.request.actor,
    conversation: parentRun.request.conversation,
    surface: parentRun.request.surface ?? "test",
  });
  for (const person of parentRun.request.conversation.audience)
    await built.sessions.addParticipant(child.id, person.id);
  built.runtime.startBackground();
  const firstUserEntry = async (threadRef: string, extra: { sessionSenderId?: string; displayText?: string }) => {
    const text = "<subagent-task>Summarize the repo</subagent-task>";
    const { run } = await built.runs.enqueue({
      sessionId: threadRef,
      request: {
        ...parentRun.request,
        conversation: { ...parentRun.request.conversation, threadRef },
        origin: { kind: "automation", screenData: text },
        text,
        ...extra,
      },
    });
    for (const deadline = Date.now() + 10_000; ; await sleep(25)) {
      const current = (await built.runs.get(run.id))!;
      if (current.status === "done" || current.status === "failed") {
        assert.equal(current.result?.status, "ok", JSON.stringify(current.result));
        break;
      }
      assert.ok(Date.now() < deadline, "automated turn did not finish");
    }
    const session = (await built.sessions.getByThread(threadRef))!;
    const entries = await built.sessions.getEntries(session.id);
    return entries.find((entry) => entry.type === "user")!.payload as { hidden?: boolean; display?: string };
  };

  const task = await firstUserEntry("agent:main:subagent:visibility", {
    sessionSenderId: parentSession.id,
    displayText: "Summarize the repo",
  });
  assert.notEqual(task.hidden, true);
  assert.equal(task.display, "Summarize the repo");

  assert.equal((await firstUserEntry("cron:visibility", {})).hidden, true);
});
