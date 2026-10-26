import { test } from "node:test";
import assert from "node:assert/strict";
import { continuableContext, createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { INTERRUPTED_TOOL_RESULT } from "../src/harness/context-compaction.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

type Sink = {
  entries: Item[];
};

type RequestBody = { messages: Array<{ role: string; content: unknown }> };

function entry(item: NewItem, seq: number): Item {
  return storedItem(item, { sessionId: "s", seq, createdAt: seq });
}

const ASK = entry({ kind: "UserMessage", text: "list the files" }, 1);
const CALL = entry({ kind: "ToolCall", tool: "execute", callId: "c1", body: { command: "ls" } }, 2);
const RESULT = entry({ kind: "ToolResult", callId: "c1", text: "a.txt\nb.txt" }, 3);
const SAFE_CALL = entry(
  {
    kind: "ToolCall",
    tool: "history",
    callId: "c-budget",
    body: { query: "budget", retrySafe: true, rerun: { tool: "history", input: { query: "budget" } } },
  },
  2,
);

function turnInput(sink: Sink, overrides: Partial<HarnessTurnInput>): HarnessTurnInput {
  let seq = 10;
  return {
    session: { id: "resume" } as HarnessTurnInput["session"],
    runId: "run-1",
    input: "list the files",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (e: NewItem) => {
      const appended = storedItem(e, { sessionId: "resume", seq: seq++, createdAt: Date.now() });
      sink.entries.push(appended);
      return appended;
    },
    recordModelCall: () => {},
    ...overrides,
  };
}

function sse(text: string): Response {
  const events: Array<Record<string, unknown>> = [
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
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function runResume(history: Item[], overrides: Partial<HarnessTurnInput> = {}) {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [] };
  const requests: RequestBody[] = [];
  const llmTurnSeqs: Array<number | null> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")) as RequestBody);
    return sse("done: two files");
  }) as typeof globalThis.fetch;
  try {
    const result = await harness.turns.runTurn(
      turnInput(sink, {
        history,
        recordLlmRequest: (rec) => {
          llmTurnSeqs.push(rec.turnSeq);
        },
        ...overrides,
      }),
    );
    return { result, sink, requests, llmTurnSeqs };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function userTexts(requests: RequestBody[]): string[] {
  type Block = { type: string; text?: string };
  return requests[0]!.messages
    .filter((m) => m.role === "user")
    .flatMap((m): Block[] =>
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Block[]),
    )
    .flatMap((b) => (b.type === "text" && b.text ? [b.text] : []));
}

test("a genuine resume whose context ends at a recorded tool result continues the assistant turn silently", async () => {
  const { result, sink, requests, llmTurnSeqs } = await runResume([ASK, CALL, RESULT], {
    continueTurn: true,
    resumeUserSeq: ASK.seq,
  });
  assert.equal(result.reply, "done: two files");
  assert.deepEqual(llmTurnSeqs, [ASK.seq], "model requests are attributed to the run's original user entry");
  assert.equal(requests.length, 1);
  const last = requests[0]!.messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.ok(
    (last.content as Array<{ type: string }>).some((block) => block.type === "tool_result"),
    "the model resumes right after the recorded tool result",
  );
  assert.deepEqual(
    userTexts(requests),
    ["── Wednesday, December 31, 1969 ──\nlist the files"],
    "the request reaches the model once and nothing else is prompted",
  );
  assert.deepEqual(
    sink.entries.map((e) => e.kind),
    ["AgentMessage"],
    "no user entry is appended for the resumed attempt",
  );
});

test("a resume that re-runs a retry-safe call continues the assistant turn right after the re-run result", async () => {
  const queries: string[] = [];
  const { result, sink, requests } = await runResume([ASK, SAFE_CALL], {
    continueTurn: true,
    resumeUserSeq: ASK.seq,
    resumeToolCall: { callId: "c-budget", tool: "history", input: { query: "budget" } },
    tools: {
      async history(q: string) {
        queries.push(q);
        return ["user#1: the budget doc is in shared/q2.md"];
      },
    } as unknown as ToolContext,
  });
  assert.equal(result.reply, "done: two files");
  assert.deepEqual(queries, ["budget"], "the interrupted call ran exactly once");
  assert.deepEqual(
    sink.entries.map((e) => e.kind),
    ["ToolResult", "AgentMessage"],
    "no note entry follows the re-run",
  );
  const flattened = JSON.stringify(requests[0]!.messages);
  assert.ok(flattened.includes("shared/q2.md"), "the model sees the re-run result");
  assert.deepEqual(userTexts(requests), ["── Wednesday, December 31, 1969 ──\nlist the files"]);
  assert.ok(!flattened.includes("[interrupted"));
});

test("a resume whose last tool call never recorded a result continues silently after the interrupted result", async () => {
  const { sink, requests } = await runResume([ASK, CALL], { continueTurn: true, resumeUserSeq: ASK.seq });
  assert.ok(JSON.stringify(requests[0]!.messages.at(-1)).includes(INTERRUPTED_TOOL_RESULT));
  assert.deepEqual(userTexts(requests), ["── Wednesday, December 31, 1969 ──\nlist the files"]);
  assert.deepEqual(
    sink.entries.map((e) => e.kind),
    ["AgentMessage"],
  );
});

test("a resume that died before any work continues from the recorded request without re-sending it", async () => {
  const { sink, requests } = await runResume([ASK], { continueTurn: true, resumeUserSeq: ASK.seq });
  assert.equal(requests[0]!.messages.length, 1);
  assert.deepEqual(userTexts(requests), ["── Wednesday, December 31, 1969 ──\nlist the files"]);
  assert.deepEqual(
    sink.entries.map((e) => e.kind),
    ["AgentMessage"],
  );
});

test("a resume that died before delivering its reply drops that reply and continues without a prompt", async () => {
  const partialReply = entry(
    {
      kind: "AgentMessage",
      variant: "narration",
      text: "Here are",
      step: 0,
      body: {
        wire: {
          message: {
            id: "s1",
            stopReason: "stop",
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-test",
          },
        },
      },
    },
    4,
  );
  const { sink, requests } = await runResume([ASK, CALL, RESULT, partialReply], {
    continueTurn: true,
    resumeUserSeq: ASK.seq,
  });
  assert.equal(requests[0]!.messages.at(-1)!.role, "user");
  assert.ok(!JSON.stringify(requests[0]!.messages).includes("Here are"));
  assert.deepEqual(userTexts(requests), ["── Wednesday, December 31, 1969 ──\nlist the files"]);
  assert.deepEqual(
    sink.entries.map((e) => e.kind),
    ["AgentMessage"],
  );
});

test("without the resume signal a context ending at a tool result is prompted normally", async () => {
  const { sink, requests } = await runResume([ASK, CALL, RESULT], { input: "follow-up question" });
  assert.equal(JSON.stringify(requests[0]!.messages).includes("follow-up question"), true);
  assert.equal(sink.entries[0]?.kind, "UserMessage");
});

test("continuableContext trims a trailing assistant and needs a user or tool result to continue from", () => {
  const result = { role: "toolResult" };
  const reply = { role: "assistant" };
  assert.deepEqual(continuableContext([{ role: "user" }, result]), [{ role: "user" }, result]);
  assert.deepEqual(continuableContext([{ role: "user" }, reply]), [{ role: "user" }]);
  assert.equal(continuableContext([reply]), null);
  assert.equal(continuableContext([]), null);
});
