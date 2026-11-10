import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agent/agent-run.ts";
import { createModelRoutes } from "../src/model/model-route.ts";
import { REPLY_CHECK_LIMITS, replyCheckPrompt, type AgentTurnInput, type ReplyVerdict } from "../src/agent/agent.ts";
import { storedItem, type Item } from "../src/sessions/items.ts";
import type { RunSignal, RunSignalStore } from "../src/runs/run-signal-store.ts";
import { reconstructMessagesFromHistory } from "../src/agent/replay.ts";
import { forModelContext } from "../src/agent/context-compaction.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";

type Sink = { entries: Item[] };

const narration = (item: Item): boolean => item.kind === "AgentMessage" && item.variant === "narration";

function turnInput(sessionId: string, sink: Sink, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  let seq = 0;
  return {
    session: { id: sessionId } as AgentTurnInput["session"],
    input: "status?",
    systemPrompt: "BASE",
    history: [],
    tools: {} as AgentTurnInput["tools"],
    scopeLabel: "personal:tester" as AgentTurnInput["scopeLabel"],
    orgScopeId: "org:test" as AgentTurnInput["orgScopeId"],
    emit: async (item) => {
      const stored = storedItem(item, { sessionId, seq: seq++, createdAt: Date.now() });
      sink.entries.push(stored);
      return stored;
    },
    recordModelCall: () => {},
    ...overrides,
  };
}

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textReplyEvents(text: string, thinking?: string): Array<Record<string, unknown>> {
  const at = thinking ? 1 : 0;
  return [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    ...(thinking
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
          { type: "content_block_stop", index: 0 },
        ]
      : []),
    { type: "content_block_start", index: at, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: at, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: at },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

function fakeModel(replies: string[], thinking?: string) {
  const requests: Array<Array<{ role: string; content: unknown }>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push((JSON.parse(String(init?.body ?? "{}")) as { messages?: [] }).messages ?? []);
    return sse(textReplyEvents(replies[Math.min(requests.length, replies.length) - 1]!, thinking));
  }) as typeof globalThis.fetch;
  return { requests, restore: () => (globalThis.fetch = realFetch) };
}

const userText = (message: { content: unknown }) =>
  (message.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");

const emDashVerdict: ReplyVerdict = { action: "retry", reason: "em dash", message: "Rewrite it without em dashes." };
const emDash = async (draft: string) => (draft.includes("\u2014") ? emDashVerdict : undefined);

function memorySignals(): RunSignalStore & { send(runId: string, signal: RunSignal): Promise<boolean> } {
  const queued = new Map<string, Array<{ id: string; signal: RunSignal }>>();
  const listeners = new Map<string, Set<() => void>>();
  let next = 0;
  return {
    async send(runId, signal) {
      queued.set(runId, [...(queued.get(runId) ?? []), { id: String(next++), signal }]);
      for (const cb of listeners.get(runId) ?? []) cb();
      return true;
    },
    runForDedupeKey: async () => undefined,
    pending: async (runId) => [...(queued.get(runId) ?? [])],
    acknowledge: async (runId, id) =>
      void queued.set(
        runId,
        (queued.get(runId) ?? []).filter((s) => s.id !== id),
      ),
    async takePending(runId) {
      const taken = queued.get(runId) ?? [];
      queued.delete(runId);
      return taken.map((s) => s.signal);
    },
    steerAuthors: async () => [],
    pendingRuns: async () => [...queued.keys()].map((id) => ({ tenantId: TEST_TENANT, id })),
    prune: async () => {},
    onSignal(runId, cb) {
      const set = listeners.get(runId) ?? new Set();
      set.add(cb);
      listeners.set(runId, set);
      return () => set.delete(cb);
    },
  };
}

test("a reply that fails the check streams, is persisted as retracted, and is rewritten as a new reply", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Here \u2014 a draft.", "Here is a clean reply."], "let me think");
  const order: string[] = [];
  try {
    const result = await agent.runTurn(
      turnInput("reply-retract", sink, {
        onDelta: (chunk) => order.push(`delta:${chunk}`),
        onTextBlockStart: () => void order.push("block"),
        checkReply: async (draft) => {
          order.push(`check:${draft}`);
          return emDash(draft);
        },
      }),
    );
    assert.equal(result.reply, "Here is a clean reply.");
    assert.deepEqual(result.retracted, ["em dash"]);
    assert.deepEqual(order, [
      "block",
      "delta:Here \u2014 a draft.",
      "check:Here \u2014 a draft.",
      "block",
      "block",
      "delta:Here is a clean reply.",
      "check:Here is a clean reply.",
    ]);
    const draft = sink.entries.find(narration);
    assert.equal(draft?.text, "Here \u2014 a draft.");
    assert.equal(draft?.body.retracted, "em dash");
    assert.deepEqual(
      sink.entries.map((e) => [e.kind, e.variant]),
      [
        ["UserMessage", null],
        ["Reasoning", null],
        ["AgentMessage", "narration"],
        ["Reasoning", null],
        ["AgentMessage", null],
      ],
    );
    assert.equal(sink.entries.at(-1)!.text, "Here is a clean reply.");
    assert.ok(!JSON.stringify(sink.entries).includes("retracted your reply"));
    assert.equal(model.requests.length, 2);
    const second = model.requests[1]!;
    assert.deepEqual(
      second.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.equal(userText(second[2]!), replyCheckPrompt(emDashVerdict));
  } finally {
    model.restore();
  }
});

test("later turns replay only the rewrite, never the retracted draft or its thinking", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Here \u2014 a draft.", "Here is a clean reply."], "draft thinking");
  try {
    await agent.runTurn(turnInput("reply-replay", sink, { checkReply: emDash }));
  } finally {
    model.restore();
  }
  const history = sink.entries.map((e, i) => ({ ...e, createdAt: 1_000 + i }));
  const replayed = reconstructMessagesFromHistory(forModelContext(history));
  assert.deepEqual(
    replayed.map((m) => m.role),
    ["user", "assistant"],
  );
  const text = JSON.stringify(replayed);
  assert.ok(text.includes("Here is a clean reply."));
  assert.ok(!text.includes("a draft"));
});

test("a passing reply is checked once and nothing else changes", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["All quiet."]);
  const order: string[] = [];
  try {
    const result = await agent.runTurn(
      turnInput("reply-pass", sink, {
        onDelta: (chunk) => order.push(`delta:${chunk}`),
        checkReply: async (draft) => {
          order.push(`check:${draft}`);
          return undefined;
        },
      }),
    );
    assert.equal(result.reply, "All quiet.");
    assert.equal(result.retracted, undefined);
    assert.deepEqual(order, ["delta:All quiet.", "check:All quiet."]);
    assert.equal(model.requests.length, 1);
    assert.ok(!sink.entries.some((e) => e.body.retracted));
  } finally {
    model.restore();
  }
});

test("rewrites are capped; the last draft ships even if the check still objects", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["one \u2014", "two \u2014", "three \u2014", "four"]);
  try {
    const result = await agent.runTurn(turnInput("reply-cap", sink, { checkReply: emDash }));
    assert.equal(model.requests.length, REPLY_CHECK_LIMITS.retry + 1);
    assert.equal(result.reply, "three \u2014");
    assert.deepEqual(result.retracted, ["em dash", "em dash"]);
    assert.deepEqual(
      sink.entries.filter((e) => e.body.retracted).map((e) => e.text),
      ["one \u2014", "two \u2014"],
    );
  } finally {
    model.restore();
  }
});

test("a check that throws never retracts", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Fine \u2014 really."]);
  try {
    const result = await agent.runTurn(
      turnInput("reply-throw", sink, {
        checkReply: async () => {
          throw new Error("classifier down");
        },
      }),
    );
    assert.equal(result.reply, "Fine \u2014 really.");
    assert.equal(model.requests.length, 1);
    assert.ok(!sink.entries.some((e) => e.body.retracted));
  } finally {
    model.restore();
  }
});

test("a stop pressed while the check runs keeps the finished reply instead of retracting it", async () => {
  const signals = memorySignals();
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }), signals });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["draft \u2014 one", "never requested"]);
  try {
    const result = await agent.runTurn(
      turnInput("reply-abort", sink, {
        runId: "run-abort",
        checkReply: async (draft) => {
          await signals.send("run-abort", { kind: "abort", ts: "1712.002" });
          await new Promise((resolve) => setTimeout(resolve, 150));
          return emDash(draft);
        },
      }),
    );
    assert.equal(model.requests.length, 1);
    assert.equal(result.reply, "draft \u2014 one");
    assert.ok(!sink.entries.some((e) => e.body.retracted));
  } finally {
    model.restore();
  }
});

const unfinishedVerdict: ReplyVerdict = {
  action: "prod",
  reason: "unfinished",
  message:
    "Your reply leaves an open question you can answer with your tools. Investigate it now, then reply with what you found.",
};

test("a prodded reply stays as an interim reply and the agent keeps working to a final answer", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Core is busy. I haven't traced why.", "Traced it: the mirror sync loop holds the CPU."]);
  const interim: string[] = [];
  const checks: string[] = [];
  try {
    const result = await agent.runTurn(
      turnInput("reply-prod", sink, {
        onInterimReply: (text) => (interim.push(text), true),
        checkReply: async (draft) => {
          checks.push(draft);
          return draft.includes("haven't traced") ? unfinishedVerdict : undefined;
        },
      }),
    );
    assert.equal(result.reply, "Traced it: the mirror sync loop holds the CPU.");
    assert.deepEqual(result.prodded, ["unfinished"]);
    assert.equal(result.retracted, undefined);
    assert.deepEqual(interim, ["Core is busy. I haven't traced why."]);
    assert.deepEqual(checks, ["Core is busy. I haven't traced why.", "Traced it: the mirror sync loop holds the CPU."]);
    const draft = sink.entries.find(narration);
    assert.equal(draft?.text, "Core is busy. I haven't traced why.");
    assert.equal(draft?.body.prodded, "unfinished");
    assert.equal(draft?.body.retracted, undefined);
    const wake = sink.entries.find((e) => e.kind === "Wake");
    assert.equal(wake?.body.text, replyCheckPrompt(unfinishedVerdict));
    const second = model.requests[1]!;
    assert.deepEqual(
      second.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.equal(userText(second[2]!), replyCheckPrompt(unfinishedVerdict));
  } finally {
    model.restore();
  }
});

test("later turns replay the prodded reply, the reminder and the final answer in order", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Core is busy. I haven't traced why.", "Traced it."]);
  try {
    await agent.runTurn(
      turnInput("reply-prod-replay", sink, {
        onInterimReply: () => true,
        checkReply: async (draft) => (draft.includes("haven't traced") ? unfinishedVerdict : undefined),
      }),
    );
  } finally {
    model.restore();
  }
  const history = sink.entries.map((e, i) => ({ ...e, createdAt: 1_000 + i }));
  const replayed = reconstructMessagesFromHistory(forModelContext(history));
  assert.deepEqual(
    replayed.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  const text = JSON.stringify(replayed);
  assert.ok(text.indexOf("haven't traced") < text.indexOf("stopped early"));
  assert.ok(text.indexOf("stopped early") < text.indexOf("Traced it."));
});

test("an agent is prodded at most once per turn", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["first stop", "second stop", "never requested"]);
  try {
    const result = await agent.runTurn(
      turnInput("reply-prod-cap", sink, { onInterimReply: () => true, checkReply: async () => unfinishedVerdict }),
    );
    assert.equal(model.requests.length, REPLY_CHECK_LIMITS.prod + 1);
    assert.equal(result.reply, "second stop");
    assert.deepEqual(result.prodded, ["unfinished"]);
  } finally {
    model.restore();
  }
});

test("a prodded turn can still have its final answer retracted and rewritten", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Not traced yet.", "Traced \u2014 the sync loop.", "Traced: the sync loop."]);
  try {
    const result = await agent.runTurn(
      turnInput("reply-prod-retry", sink, {
        onInterimReply: () => true,
        checkReply: async (draft) => (draft.includes("Not traced") ? unfinishedVerdict : emDash(draft)),
      }),
    );
    assert.equal(result.reply, "Traced: the sync loop.");
    assert.deepEqual(result.prodded, ["unfinished"]);
    assert.deepEqual(result.retracted, ["em dash"]);
    assert.deepEqual(
      sink.entries.filter(narration).map((e) => [e.text, e.body.prodded ?? e.body.retracted]),
      [
        ["Not traced yet.", "unfinished"],
        ["Traced \u2014 the sync loop.", "em dash"],
      ],
    );
  } finally {
    model.restore();
  }
});

test("a prod nobody can see is ignored and the reply stands", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  for (const onInterimReply of [undefined, () => false]) {
    const sink: Sink = { entries: [] };
    const model = fakeModel(["Core is busy. I haven't traced why.", "never requested"]);
    try {
      const result = await agent.runTurn(
        turnInput("reply-prod-unseen", sink, {
          ...(onInterimReply ? { onInterimReply } : {}),
          checkReply: async () => unfinishedVerdict,
        }),
      );
      assert.equal(model.requests.length, 1);
      assert.equal(result.reply, "Core is busy. I haven't traced why.");
      assert.equal(result.prodded, undefined);
      assert.ok(!sink.entries.some((e) => e.body.prodded));
    } finally {
      model.restore();
    }
  }
});
