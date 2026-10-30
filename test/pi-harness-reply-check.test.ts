import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { replyCheckPrompt, REPLY_CHECK_RETRIES } from "../src/harness/harness.ts";
import { reconstructMessagesFromHistory } from "../src/harness/replay.ts";

type Sink = { entries: Array<{ seq: number; type: string; payload: Record<string, unknown> }> };

function turnInput(sessionId: string, sink: Sink, overrides: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    input: "status?",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry: NewEntry) => {
      const appended = { ...entry, seq: seq++, createdAt: Date.now() };
      sink.entries.push({ seq: appended.seq, type: entry.type, payload: entry.payload as Record<string, unknown> });
      return appended as unknown as SessionEntry;
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

const emDash = async (draft: string) =>
  draft.includes("\u2014") ? { reason: "em dash", message: "Rewrite it without em dashes." } : undefined;

test("a reply that fails the check streams, is persisted as retracted, and is rewritten as a new reply", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Here \u2014 a draft.", "Here is a clean reply."], "let me think");
  const order: string[] = [];
  try {
    const result = await harness.turns.runTurn(
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
    const draft = sink.entries.find((e) => e.type === "text");
    assert.equal(draft?.payload.text, "Here \u2014 a draft.");
    assert.equal(draft?.payload.retracted, "em dash");
    assert.deepEqual(
      sink.entries.map((e) => e.type),
      ["user", "thinking", "text", "thinking", "assistant"],
    );
    assert.equal(sink.entries.at(-1)!.payload.text, "Here is a clean reply.");
    assert.ok(!JSON.stringify(sink.entries).includes("retracted your reply"));
    assert.equal(model.requests.length, 2);
    const second = model.requests[1]!;
    assert.deepEqual(
      second.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    assert.equal(userText(second[2]!), replyCheckPrompt("Rewrite it without em dashes."));
  } finally {
    model.restore();
  }
});

test("later turns replay only the rewrite, never the retracted draft or its thinking", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Here \u2014 a draft.", "Here is a clean reply."], "draft thinking");
  try {
    await harness.turns.runTurn(turnInput("reply-replay", sink, { checkReply: emDash }));
  } finally {
    model.restore();
  }
  const history = sink.entries.map((e, i) => ({
    ...e,
    createdAt: 1_000 + i,
    scopeLabel: "personal:tester",
  })) as unknown as SessionEntry[];
  const replayed = reconstructMessagesFromHistory(history);
  assert.deepEqual(
    replayed.map((m) => m.role),
    ["user", "assistant"],
  );
  const text = JSON.stringify(replayed);
  assert.ok(text.includes("Here is a clean reply."));
  assert.ok(!text.includes("a draft"));
});

test("a passing reply is checked once and nothing else changes", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["All quiet."]);
  const order: string[] = [];
  try {
    const result = await harness.turns.runTurn(
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
    assert.ok(!sink.entries.some((e) => e.payload.retracted));
  } finally {
    model.restore();
  }
});

test("rewrites are capped; the last draft ships even if the check still objects", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["one \u2014", "two \u2014", "three \u2014", "four"]);
  try {
    const result = await harness.turns.runTurn(turnInput("reply-cap", sink, { checkReply: emDash }));
    assert.equal(model.requests.length, REPLY_CHECK_RETRIES + 1);
    assert.equal(result.reply, "three \u2014");
    assert.deepEqual(result.retracted, ["em dash", "em dash"]);
    assert.deepEqual(
      sink.entries.filter((e) => e.payload.retracted).map((e) => e.payload.text),
      ["one \u2014", "two \u2014"],
    );
  } finally {
    model.restore();
  }
});

test("a check that throws never retracts", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["Fine \u2014 really."]);
  try {
    const result = await harness.turns.runTurn(
      turnInput("reply-throw", sink, {
        checkReply: async () => {
          throw new Error("classifier down");
        },
      }),
    );
    assert.equal(result.reply, "Fine \u2014 really.");
    assert.equal(model.requests.length, 1);
    assert.ok(!sink.entries.some((e) => e.payload.retracted));
  } finally {
    model.restore();
  }
});

test("a stop pressed while the check runs keeps the finished reply instead of retracting it", async () => {
  const signals = createMemoryRunSignalStore();
  const harness = createPiHarness({ apiKey: "sk-test", signals });
  const sink: Sink = { entries: [] };
  const model = fakeModel(["draft \u2014 one", "never requested"]);
  try {
    const result = await harness.turns.runTurn(
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
    assert.ok(!sink.entries.some((e) => e.payload.retracted));
  } finally {
    model.restore();
  }
});
