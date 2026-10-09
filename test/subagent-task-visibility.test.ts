import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("a delegated subagent task stays visible in the child transcript; other automated prompts stay hidden", async () => {
  const built = buildApp(testConfig());
  const parent = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:subagent-visibility" },
    text: "hello",
  });
  assert.equal(parent.status, "ok");
  const automated = (threadRef: string, extra: { sessionSenderId?: string; displayText?: string }) =>
    built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      origin: { kind: "automation", screenData: "<subagent-task>Summarize the repo</subagent-task>" },
      conversation: { kind: "dm", threadRef },
      text: "<subagent-task>Summarize the repo</subagent-task>",
      ...extra,
    });
  const firstUser = async (sessionId: string) =>
    (await built.app.getSession(sessionId))!.entries.find((entry) => entry.type === "user")!.payload as {
      hidden?: boolean;
      display?: string;
    };

  const child = await automated("agent:main:subagent:visibility", {
    sessionSenderId: parent.sessionId!,
    displayText: "Summarize the repo",
  });
  assert.equal(child.status, "ok");
  const task = await firstUser(child.sessionId!);
  assert.notEqual(task.hidden, true);
  assert.equal(task.display, "Summarize the repo");

  const wake = await automated("cron:visibility", {});
  assert.equal(wake.status, "ok");
  assert.equal((await firstUser(wake.sessionId!)).hidden, true);
});
