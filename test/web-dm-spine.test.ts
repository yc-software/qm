import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { isShownReply } from "../src/sessions/items.ts";
import { scopeId } from "../src/types.ts";

test("with web_dm_spine on, a web DM speaks by posting and a wake edits the posted message", async () => {
  const mock = createMockAgent();
  const turns: { input: string; environment: string; systemPrompt: string }[] = [];
  let wakeCommand: string | undefined;
  const built = buildApp(testConfig({ memoryCapture: "off" }), {
    agent: {
      ...mock,
      runTurn: (turn) => {
        turns.push({ input: turn.input, environment: turn.environment ?? "", systemPrompt: turn.systemPrompt });
        const wake = turn.input.startsWith("A delegated task finished") && wakeCommand;
        return mock.runTurn(wake ? { ...turn, input: wake } : turn);
      },
    },
  });
  for (const flag of ["web_dm_spine", "wake_reply_rewrite"] as const)
    await built.featureFlags.setEnabled(flag, scopeId("personal", "U1"), true, "test");
  built.runtime.start();
  const threadRef = "web:U1:spine";
  const typed = (text: string, actor = "U1", thread = threadRef, extra = {}) =>
    built.app.turn({
      ...extra,
      surface: "web",
      actor: { externalId: actor },
      conversation: { kind: "dm", threadRef: thread },
      deliveryTarget: thread,
      origin: { kind: "human" },
      text,
    });
  const shown = async (thread = threadRef) =>
    (await built.sessions.getItems((await built.sessions.getByThread(thread))!.id)).filter(isShownReply);

  assert.equal((await typed("!post On it")).status, "silent");
  const [posted, ...extra] = await shown();
  assert.deepEqual([posted!.text, extra.length, posted!.body.supersedes], ["On it", 0, undefined]);
  assert.ok(turns[0]!.systemPrompt.includes("as if everything now known had been known all along"));
  assert.ok(turns[0]!.systemPrompt.includes("You cannot execute commands yourself"));
  const items = await built.sessions.getItems(posted!.sessionId);
  const result = items.find((item) => item.kind === "ToolResult" && item.callId === posted!.body.callId)!;
  assert.equal(result.seq, posted!.seq - 1, "the message follows its call's result");
  assert.deepEqual(await built.deliveries.pending("web"), []);

  const session = (await built.sessions.getByThread(threadRef))!;
  const [run] = await built.runs.list({ threadRef, limit: 1 });
  const syscalls = built.sessionSyscalls.forTurn({
    session,
    scopeId: session.scopeId,
    request: { ...run!.request, runId: run!.id },
  });
  const wake = async (command?: string) => {
    wakeCommand = command;
    const opened = await syscalls.open({ task: "Summarize the repo" });
    assert.ok(opened.ok);
    const child = (await built.sessions.get(opened.sessionId))!;
    await settle(async () => {
      const [task] = await built.runs.list({ threadRef: child.threadRef, limit: 1 });
      return (task && (await built.runs.getByDedupKey(`subagent-return:${task.id}`)))?.status === "done";
    });
    return shown();
  };

  const edited = (await wake(`!edit ${posted!.seq} Done: the repo is small`)).at(-1)!;
  assert.deepEqual([edited.text, edited.body.supersedes], ["Done: the repo is small", posted!.seq]);
  assert.ok(turns.at(-1)!.environment.includes(`Your latest message here is ref ${posted!.seq}, beginning "On it"`));
  assert.ok(
    !/Your reply replaces|anything you write is shown/.test(turns.at(-1)!.environment),
    "with both flags on, this one governs",
  );
  const again = (await wake(`!edit ${edited.seq} Done: the repo is small and tidy`)).at(-1)!;
  assert.equal(again.body.supersedes, edited.seq, "an edit chains onto the newest version");
  assert.equal((await wake(`!edit ${posted!.seq} nope`)).length, 3, "only the newest message can be edited");
  assert.equal((await wake()).length, 3, "text written on a wake is never a message");

  await typed("hello");
  assert.ok((await shown()).at(-1)!.text!.startsWith("You said: hello"), "an unposted answer to the person is shown");

  const held = await typed("!paused-approval deploy");
  const approval = { requestId: held.pendingApprovals![0]!.requestId, approved: true };
  await typed("!post Deployed", "U1", threadRef, { approval });
  assert.equal((await shown()).at(-1)!.text, "Deployed", "an approved turn still speaks by posting");

  const plain = await typed("hello", "U2", "web:U2:plain");
  assert.deepEqual([plain.status, plain.reply?.startsWith("You said: hello")], ["ok", true], "flag off: unchanged");
  assert.ok(turns.at(-1)!.systemPrompt.includes("What you write IS your reply"));
});
