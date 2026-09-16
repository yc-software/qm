import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseConversationRoutes,
  routeConversationMessage,
  type ConversationRoutingInput,
} from "../src/wake/conversation-router.ts";

const input: ConversationRoutingInput = {
  message: "Actually Tuesday. Separately, check the invoice.",
  recentMessages: [{ author: "person", text: "Schedule our meeting for Monday." }],
  tasks: [
    { id: "meeting", request: "Schedule the meeting", state: "running", updates: [] },
    { id: "website", request: "Build a website", state: "running", updates: [] },
  ],
};

const routes = [
  { text: "Actually Tuesday. ", action: "update", taskIds: ["meeting"] },
  { text: "Separately, check the invoice.", action: "start" },
];

test("one instruction can target multiple tasks without duplicating its text", () => {
  const message = "Stop both";
  const proposed = [{ text: message, action: "cancel", taskIds: ["meeting", "website"] }];
  assert.deepEqual(parseConversationRoutes(JSON.stringify({ routes: proposed }), { ...input, message }), {
    status: "resolved",
    routes: proposed,
  });
  for (const taskIds of [[], ["meeting", "meeting"], ["meeting", "unknown"], "meeting"]) {
    assert.deepEqual(
      parseConversationRoutes(JSON.stringify({ routes: [{ ...proposed[0], taskIds }] }), { ...input, message }),
      {
        status: "pending",
        reason: "invalid",
      },
    );
  }
});

test("unambiguous stop bypasses an unavailable routing model", async () => {
  for (const context of [
    { ...input, tasks: [input.tasks[0]!] },
    { ...input, replyToTaskId: "meeting" },
  ]) {
    assert.deepEqual(await routeConversationMessage(undefined, { ...context, message: "Stop!" }), {
      status: "resolved",
      routes: [{ text: "Stop!", action: "cancel", taskIds: ["meeting"] }],
    });
  }
});

test("ambiguous stop and stale reply context never cancel an arbitrary active task", async () => {
  for (const context of [input, { ...input, tasks: [input.tasks[0]!], replyToTaskId: "missing" }]) {
    assert.deepEqual(await routeConversationMessage(undefined, { ...context, message: "stop" }), {
      status: "pending",
      reason: "unavailable",
    });
  }
});

test("mixed messages retain every character and route independently", () => {
  assert.deepEqual(parseConversationRoutes(JSON.stringify({ routes }), input), { status: "resolved", routes });
});

test("a bad segment rejects the entire proposal before any action is applied", () => {
  const malformed = [
    [routes[0]],
    [routes[1], routes[0]],
    [routes[0], { ...routes[1], text: "check the invoice." }],
    [routes[0], { ...routes[1], action: "update", taskIds: ["private-task"] }],
    [routes[0], { ...routes[1], taskIds: ["website"] }],
    [routes[0], { ...routes[1], action: "cancel" }],
    [routes[0], { ...routes[1], action: "clarify", question: " " }],
    [routes[0], { ...routes[1], action: "ignore" }],
    [routes[0], { ...routes[1], text: "" }],
  ];
  for (const proposal of malformed) {
    assert.deepEqual(parseConversationRoutes(JSON.stringify({ routes: proposal }), input), {
      status: "pending",
      reason: "invalid",
    });
  }
});

test("malformed model output never steers the newest task", () => {
  for (const raw of [undefined, "", "steer", "null", "[]", "{}", '{"routes":[]}', '{"routes":"new"}']) {
    assert.deepEqual(parseConversationRoutes(raw, input), { status: "pending", reason: "invalid" });
  }
});

test("uncertainty can ask a question while another clear part proceeds", () => {
  const proposed = [
    {
      text: "Actually Tuesday. ",
      action: "clarify",
      question: "Should Tuesday be the meeting date or the website deadline?",
    },
    routes[1],
  ];
  assert.deepEqual(parseConversationRoutes(JSON.stringify({ routes: proposed }), input), {
    status: "resolved",
    routes: proposed,
  });
});

test("questions and updates can target completed work without silently becoming new tasks", () => {
  for (const action of ["answer", "update"]) {
    const proposed = [{ text: input.message, action, taskIds: ["meeting"] }];
    assert.deepEqual(
      parseConversationRoutes(JSON.stringify({ routes: proposed }), {
        ...input,
        tasks: input.tasks.map((task) => ({ ...task, state: "completed" })),
      }),
      { status: "resolved", routes: proposed },
    );
  }
});

test("the judge receives the full conversation, accepted updates, and explicit reply context", async () => {
  const contextual: ConversationRoutingInput = {
    ...input,
    replyToTaskId: "meeting",
    tasks: [{ ...input.tasks[0]!, updates: ["Move it to Wednesday."] }],
  };
  let seen: unknown;
  await routeConversationMessage(async (_system, prompt) => {
    seen = JSON.parse(prompt);
    return JSON.stringify({ routes });
  }, contextual);
  assert.deepEqual(seen, {
    ...contextual,
    replyToTaskId: "t1",
    tasks: contextual.tasks.map((task) => ({ ...task, id: "t1" })),
  });
});

test("a missing or failing judge leaves the message pending without choosing a task", async () => {
  assert.deepEqual(await routeConversationMessage(undefined, input), { status: "pending", reason: "unavailable" });
  assert.deepEqual(
    await routeConversationMessage(async () => {
      throw new Error("provider unavailable");
    }, input),
    {
      status: "pending",
      reason: "unavailable",
    },
  );
});

test("timeout cancels the provider request and does not accept a late decision", async () => {
  let signal: AbortSignal | undefined;
  const late = delay(30).then(() => JSON.stringify({ routes }));
  const result = await routeConversationMessage(
    async (_system, _prompt, requestSignal) => {
      signal = requestSignal;
      return late;
    },
    input,
    { timeoutMs: 5 },
  );
  assert.deepEqual(result, { status: "pending", reason: "timeout" });
  assert.equal(signal?.aborted, true);
  await late;
  assert.deepEqual(result, { status: "pending", reason: "timeout" });
});

test("caller cancellation is distinguished from a provider timeout", async () => {
  const controller = new AbortController();
  const result = routeConversationMessage(
    async () => {
      controller.abort();
      return JSON.stringify({ routes });
    },
    input,
    { signal: controller.signal },
  );
  assert.deepEqual(await result, { status: "pending", reason: "cancelled" });
  let called = false;
  await routeConversationMessage(
    async () => {
      called = true;
      return undefined;
    },
    input,
    { signal: controller.signal },
  );
  assert.equal(called, false);
});

test("duplicate task identities and injected output fields are invalid", () => {
  const raw = JSON.stringify({ routes });
  assert.deepEqual(parseConversationRoutes(raw, { ...input, tasks: [input.tasks[0]!, input.tasks[0]!] }), {
    status: "pending",
    reason: "invalid",
  });
  assert.deepEqual(parseConversationRoutes(JSON.stringify({ routes, permission: "approved" }), input), {
    status: "pending",
    reason: "invalid",
  });
});

test("a JSON fence preserves all route validation", () => {
  const raw = JSON.stringify({ routes });
  assert.deepEqual(parseConversationRoutes(`\`\`\`json\n${raw}\n\`\`\``, input), { status: "resolved", routes });
  for (const value of [
    `Preface\n\`\`\`json\n${raw}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify({ routes: [{ text: input.message, action: "update", taskIds: ["unknown"] }] })}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify({ routes: [{ text: "Actually Tuesday.", action: "update", taskIds: ["meeting"] }] })}\n\`\`\``,
  ])
    assert.deepEqual(parseConversationRoutes(value, input), { status: "pending", reason: "invalid" });
});

test("a leading fenced proposal tolerates trailing explanation without relaxing route validation", () => {
  assert.deepEqual(parseConversationRoutes("```json\n" + JSON.stringify({ routes }) + "\n```\nExplanation", input), {
    status: "resolved",
    routes,
  });
});

test("short task handles map back to durable IDs and invalid selections retry internally", async () => {
  let calls = 0;
  const context = {
    ...input,
    message: "Any progress?",
    tasks: [{ ...input.tasks[0]!, id: "af32dc28-70ee-4e50-9930-433140dd3062" }],
  };
  const result = await routeConversationMessage(async (system, prompt) => {
    const wire = JSON.parse(prompt);
    assert.equal(wire.tasks[0].id, "t1");
    assert.ok(!prompt.includes(context.tasks[0]!.id));
    calls++;
    if (calls === 1) return JSON.stringify({ routes: [{ text: context.message, action: "answer", taskIds: ["t99"] }] });
    assert.match(system, /previous proposal was invalid/);
    return JSON.stringify({ routes: [{ text: context.message, action: "answer", taskIds: ["t1"] }] });
  }, context);
  assert.equal(calls, 2);
  assert.deepEqual(result, {
    status: "resolved",
    routes: [{ text: context.message, action: "answer", taskIds: [context.tasks[0]!.id] }],
  });
});
