import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationFollowup } from "../src/wake/conversation-status.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import type { Run } from "../src/runs/run-store.ts";
import type { SessionEntry } from "../src/types.ts";

async function conversationStatusRequest(input: Parameters<typeof conversationFollowup>[0]) {
  const result = await conversationFollowup(input);
  return result && "request" in result ? result.request : null;
}

const request = {
  surface: "slack",
  actor: { id: "person", type: "internal" },
  conversation: { kind: "dm", threadRef: "dm:D1", audience: [{ id: "person", type: "internal" }] },
  origin: { kind: "human", messageTs: "100.2" },
  deliveryTarget: "slack:D1",
  text: "Any progress?",
} as OrchestratorInput;
const live = {
  id: "run1",
  status: "running",
  turnUserSeq: 10,
  request: { ...request, text: "Build the website" },
} as Run;
const entries = [
  { type: "text", seq: 9, createdAt: 0, payload: { text: "Previous unrelated task completed." } },
  { type: "user", seq: 10, createdAt: 1, payload: { text: "Build the website" } },
  { type: "text", seq: 11, createdAt: 2, payload: { text: "The build is running." } },
  { type: "tool_call", seq: 12, createdAt: 3, payload: { tool: "execute", command: "private command" } },
  {
    type: "tool_result",
    seq: 13,
    createdAt: 4,
    payload: { tool: "execute", result: "private output", isError: true, summary: "build failed" },
  },
] as SessionEntry[];
const base = { request, live, entries, sourceKey: "slack:bot:D1:100.2" };
const answer = JSON.stringify({ routes: [{ text: request.text, action: "answer", taskIds: ["t1"] }] });

test("status responses have a stable independent session and preserve authenticated delivery", async () => {
  const input = { ...base, judge: async () => answer };
  const result = (await conversationStatusRequest(input))!;
  const again = (await conversationStatusRequest(input))!;
  assert.notEqual(result.conversation.threadRef, request.conversation.threadRef);
  assert.equal(result.conversation.threadRef, again.conversation.threadRef);
  assert.equal(result.actor, request.actor);
  assert.equal(result.deliveryTarget, request.deliveryTarget);
  assert.equal(result.readOnly, true);
  assert.equal(result.skipMemory, true);
  assert.equal(result.surfaceTools, false);
  assert.equal(result.displayText, request.text);
  assert.match(result.text, /The build is running/);
  assert.doesNotMatch(result.text, /private command/);
  assert.doesNotMatch(result.text, /Previous unrelated task completed|private output/);
  assert.match(result.text, /"isError":true/);
  assert.match(result.text, /build failed/);
  assert.equal(live.status, "running");
  assert.equal(request.text, "Any progress?");
});

test("a task without a recorded run boundary cannot borrow earlier execution evidence", async () => {
  let prompt = "";
  const result = await conversationStatusRequest({
    ...base,
    live: { ...live, turnUserSeq: null },
    judge: async (_system, text) => {
      prompt = text;
      return answer;
    },
  });
  assert.ok(result);
  assert.match(result.text, /"observations":\[\]/);
  assert.deepEqual(JSON.parse(prompt).tasks[0].updates, []);
});

test("a new source message gets its own response session", async () => {
  const first = await conversationStatusRequest({ ...base, judge: async () => answer });
  const second = await conversationStatusRequest({
    ...base,
    sourceKey: "slack:bot:D1:100.3",
    judge: async () => answer,
  });
  assert.notEqual(first?.conversation.threadRef, second?.conversation.threadRef);
});

test("changes and invalid output cannot enter the status-only path", async () => {
  for (const raw of [
    JSON.stringify({ routes: [{ text: request.text, action: "update", taskIds: ["t1"] }] }),
    JSON.stringify({ routes: [{ text: request.text, action: "answer", taskIds: ["other"] }] }),
    "invalid",
  ])
    assert.equal(await conversationStatusRequest({ ...base, judge: async () => raw }), null);
});

test("an independent request starts durable work without read-only status constraints", async () => {
  const next = { ...request, text: "also draft me an email to josh" };
  const result = await conversationStatusRequest({
    ...base,
    request: next,
    judge: async () => JSON.stringify({ routes: [{ text: next.text, action: "start" }] }),
  });
  assert.ok(result);
  assert.match(result.conversation.threadRef, /:task:/);
  assert.equal(result.displayText, next.text);
  assert.ok(result.text.endsWith(next.text));
  assert.match(result.text, /ongoing conversation/);
  assert.equal(result.readOnly, next.readOnly);
  assert.equal(result.actor, next.actor);
  assert.equal(result.deliveryTarget, next.deliveryTarget);
});

test("follow-ups can target independent active and completed tasks", async () => {
  for (const status of ["running", "done"] as const) {
    const child = {
      ...live,
      id: "email",
      status,
      request: {
        ...request,
        text: "Draft an email to Josh",
        conversation: { ...request.conversation, threadRef: "dm:D1:task:email" },
      },
    };
    const result = await conversationFollowup({
      ...base,
      relatedRuns: [child],
      judge: async (_system, text) => {
        assert.ok(JSON.parse(text).tasks.some((task: { id: string }) => task.id === "t2"));
        return JSON.stringify({ routes: [{ text: request.text, action: "update", taskIds: ["t2"] }] });
      },
    });
    assert.deepEqual(result, { target: child, cancel: false });
  }
});

test("routing sees the person's display text rather than internal context wrappers", async () => {
  let captured = "";
  await conversationFollowup({
    ...base,
    entries: [
      { ...entries[1]!, payload: { text: "INTERNAL CONTEXT: previous requests", display: "Build the website" } },
    ],
    judge: async (_system, prompt) => {
      captured = prompt;
      return answer;
    },
  });
  assert.doesNotMatch(captured, /INTERNAL CONTEXT/);
  assert.equal(JSON.parse(captured).recentMessages[0].text, "Build the website");
  assert.deepEqual(JSON.parse(captured).tasks[0].updates, ["Build the website"]);
});

test("a resumed task keeps its original identity alongside its newest instruction", async () => {
  let captured = "";
  const original = {
    ...live,
    id: "email1",
    sessionId: "dm:D1:task:email",
    createdAt: 1,
    request: { ...request, text: "draft email to Josh" },
  };
  const continuation = { ...original, id: "email2", createdAt: 2, request: { ...request, text: "make it shorter" } };
  await conversationFollowup({
    ...base,
    relatedRuns: [continuation, original],
    judge: async (_system, prompt) => {
      captured = prompt;
      return answer;
    },
  });
  const tasks = JSON.parse(captured).tasks;
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].id, "t2");
  assert.equal(tasks[1].request, "draft email to Josh");
  assert.equal(tasks[1].createdAt, 1);
  assert.equal(tasks[1].updatedAt, 2);
  assert.ok(tasks[1].updates.includes("make it shorter"));
});

test("captionless uploads provide file context without losing attachment delivery", async () => {
  const attachments = [{ name: "proposal.pdf", mimetype: "application/pdf", sizeBytes: 10, blobId: "blob" }];
  const result = await conversationFollowup({
    ...base,
    request: { ...request, text: "", attachments },
    judge: async (_system, prompt) => {
      const input = JSON.parse(prompt);
      assert.deepEqual(input.attachments, [{ name: "proposal.pdf", mimetype: "application/pdf" }]);
      return JSON.stringify({ routes: [{ text: "", action: "start" }] });
    },
  });
  assert.ok(result && "request" in result);
  assert.deepEqual(result.request.attachments, attachments);
});

test("status snapshots cannot borrow results from unrelated completed versions", async () => {
  const result = await conversationStatusRequest({
    ...base,
    relatedRuns: [
      { ...live, id: "old", sessionId: "old", status: "done", result: { status: "ok", reply: "OLD SITE IS DONE" } },
    ],
    judge: async () => answer,
  });
  assert.ok(result);
  assert.doesNotMatch(result.text, /OLD SITE IS DONE/);
  assert.match(result.text, /"status":"running"/);
});

test("thread context identifies the task and status answers keep its reply destination", async () => {
  const task = { ...live, request: { ...live.request, deliveryTarget: "D1:100.1" } };
  const threaded = { ...request, deliveryTarget: "D1:100.1" };
  const result = await conversationStatusRequest({
    ...base,
    live: task,
    request: threaded,
    judge: async (_system, prompt) => {
      assert.equal(JSON.parse(prompt).replyToTaskId, "t1");
      return answer;
    },
  });
  assert.equal(result?.deliveryTarget, "D1:100.1");
  const fromMain = await conversationStatusRequest({
    ...base,
    live: task,
    request: { ...request, deliveryTarget: "D1:200.1" },
    judge: async () => answer,
  });
  assert.equal(fromMain?.deliveryTarget, "D1:100.1");
});

test("two tasks sharing a Slack thread do not make stop select one arbitrarily", async () => {
  const task = { ...live, request: { ...live.request, deliveryTarget: "D1:100.1" } };
  const other = { ...task, id: "other", request: { ...task.request, text: "Draft an email" } };
  let called = false;
  const result = await conversationStatusRequest({
    ...base,
    live: task,
    relatedRuns: [other],
    request: { ...request, text: "stop", deliveryTarget: "D1:100.1" },
    judge: async (_system, prompt) => {
      called = true;
      assert.equal(JSON.parse(prompt).replyToTaskId, undefined);
      return JSON.stringify({
        routes: [{ text: "stop", action: "clarify", question: "Stop the website or the email?" }],
      });
    },
  });
  assert.equal(called, true);
  assert.match(result!.text, /Stop the website or the email/);
});

test("thread replies identify originally top-level tasks and keep status answers inside the explicit thread", async () => {
  let prompt = "";
  const result = await conversationStatusRequest({
    ...base,
    request: {
      ...request,
      deliveryTarget: "D1:100.2",
      gatewayContext: { location: "DM", details: { thread_ts: "100.2" } },
    },
    live: { ...live, request: { ...live.request, deliveryTarget: "D1" } },
    judge: async (_system, text) => {
      prompt = text;
      return answer;
    },
  });
  assert.equal(JSON.parse(prompt).replyToTaskId, "t1");
  assert.equal(result?.deliveryTarget, "D1:100.2");
});

test("an original top-level task thread remains addressable after a main-DM continuation", async () => {
  const original = {
    ...live,
    sessionId: "dm:D1:task:original",
    status: "done" as const,
    request: { ...live.request, deliveryTarget: "D1" },
  };
  const continuation = {
    ...original,
    id: "continuation",
    status: "running" as const,
    request: { ...original.request, origin: { kind: "human" as const, messageTs: "101.3" } },
  };
  const result = await conversationFollowup({
    ...base,
    live: continuation,
    relatedRuns: [original],
    request: {
      ...request,
      text: "stop",
      deliveryTarget: "D1:100.2",
      gatewayContext: { location: "DM", details: { thread_ts: "100.2" } },
    },
    judge: async () => {
      throw new Error("explicit stop should not need a judge");
    },
  });
  assert.ok(result && "target" in result);
  assert.equal(result.target.id, continuation.id);
});

test("valid mixed actions and multi-task cancellations ask for clarification without dropping the message", async () => {
  const child = { ...live, id: "run2", sessionId: "dm:D1:task:email" };
  for (const routes of [
    [
      { text: "Any ", action: "answer", taskIds: ["t1"] },
      { text: "progress?", action: "update", taskIds: ["t1"] },
    ],
    [{ text: request.text, action: "cancel", taskIds: ["t1", "t2"] }],
  ]) {
    const result = await conversationStatusRequest({
      ...base,
      relatedRuns: [child],
      judge: async (system) => {
        assert.match(system, /one route per message/);
        return JSON.stringify({ routes });
      },
    });
    assert.ok(result);
    assert.equal(result.displayText, request.text);
    assert.equal(result.readOnly, true);
    assert.equal(result.skipMemory, true);
    assert.match(result.text, /Which action and task/);
  }
});

test("status reads execution evidence only for the selected parallel task", async () => {
  const child = { ...live, id: "run2", sessionId: "dm:D1:task:email", turnUserSeq: 20 };
  const unselected = { ...live, id: "run3", sessionId: "dm:D1:task:other" };
  const reads: string[] = [];
  const result = await conversationStatusRequest({
    ...base,
    relatedRuns: [child, unselected],
    entriesForTask: async (run) => {
      reads.push(run.id);
      return [
        { type: "text", seq: 19, createdAt: 4, payload: { text: "Earlier unrelated child work" } },
        { type: "text", seq: 20, createdAt: 5, payload: { text: "Email draft is being checked" } },
      ] as SessionEntry[];
    },
    judge: async () => JSON.stringify({ routes: [{ text: request.text, action: "answer", taskIds: ["t2"] }] }),
  });
  assert.ok(result);
  assert.deepEqual(reads, [child.id]);
  assert.match(result.text, /Email draft is being checked/);
  assert.doesNotMatch(result.text, /Earlier unrelated child work|The build is running/);
});

test("a clarification reply sees the completed question without treating the aside as a task", async () => {
  const email = {
    ...live,
    id: "email",
    sessionId: "dm:D1:task:email",
    createdAt: 2,
    request: { ...request, text: "Draft an email" },
  };
  const stopRequest = { ...request, text: "stop both" };
  const clarification = await conversationStatusRequest({
    ...base,
    request: stopRequest,
    relatedRuns: [email],
    judge: async () => JSON.stringify({ routes: [{ text: "stop both", action: "cancel", taskIds: ["t1", "t2"] }] }),
  });
  assert.ok(clarification);
  const aside = {
    ...live,
    id: "clarification",
    sessionId: clarification.conversation.threadRef,
    request: clarification,
    createdAt: 10,
    finishedAt: 11,
    status: "done" as const,
    result: { status: "ok" as const, reply: "Which task should I stop first?" },
  };
  const result = await conversationFollowup({
    ...base,
    request: { ...request, text: "the email" },
    relatedRuns: [aside, email],
    judge: async (_system, prompt) => {
      const context = JSON.parse(prompt);
      assert.equal(context.tasks.length, 2);
      assert.deepEqual(context.recentMessages.slice(-2), [
        { author: "person", text: "stop both" },
        { author: "assistant", text: "Which task should I stop first?" },
      ]);
      return JSON.stringify({ routes: [{ text: "the email", action: "cancel", taskIds: ["t2"] }] });
    },
  });
  assert.deepEqual(result, { target: email, cancel: true });
});
