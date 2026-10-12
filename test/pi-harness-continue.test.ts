import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness, endsAtRecordedToolResult } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { INTERRUPTED_TOOL_RESULT } from "../src/harness/context-compaction.ts";
import { resumeNote } from "../src/core/turn-resume.ts";
import type { NewEntry, NewTapeRecord } from "../src/sessions/session-store.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { SessionEntry } from "../src/types.ts";

type Sink = {
  entries: Array<{ seq: number; type: string; payload: unknown }>;
  tape: NewTapeRecord[];
};

type RequestBody = { messages: Array<{ role: string; content: unknown }> };

function entry(type: SessionEntry["type"], payload: unknown, seq: number): SessionEntry {
  return { sessionId: "s", seq, parentSeq: null, type, payload, scopeLabel: "personal:tester", createdAt: seq };
}

const ASK = entry("user", { text: "list the files", runId: "run-1" }, 1);
const CALL = entry("tool_call", { tool: "execute", callId: "c1", command: "ls" }, 2);
const RESULT = entry("tool_result", { callId: "c1", result: "a.txt\nb.txt" }, 3);
const SAFE_CALL = entry(
  "tool_call",
  {
    tool: "history",
    query: "budget",
    callId: "c-budget",
    retrySafe: true,
    rerun: { tool: "history", input: { query: "budget" } },
  },
  2,
);

function turnInput(sink: Sink, overrides: Partial<HarnessTurnInput>): HarnessTurnInput {
  let seq = 10;
  return {
    session: { id: "resume" } as HarnessTurnInput["session"],
    runId: "run-1",
    input: resumeNote(),
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (e: NewEntry) => {
      const appended = { ...e, seq: seq++, createdAt: Date.now() };
      sink.entries.push({ seq: appended.seq, type: e.type, payload: e.payload });
      return appended as unknown as SessionEntry;
    },
    tape: async (rec: NewTapeRecord) => {
      sink.tape.push(rec);
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

async function runResume(history: SessionEntry[], overrides: Partial<HarnessTurnInput> = {}) {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [], tape: [] };
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

function promptedNote(requests: RequestBody[]): boolean {
  return JSON.stringify(requests[0]!.messages).includes("(system note:");
}

test("a genuine resume whose context ends at a recorded tool result continues the assistant turn silently", async () => {
  const { result, sink, requests, llmTurnSeqs } = await runResume([ASK, CALL, RESULT], { continueTurn: true });
  assert.equal(result.reply, "done: two files");
  assert.deepEqual(llmTurnSeqs, [ASK.seq], "model requests are attributed to the run's original user entry");
  assert.equal(requests.length, 1);
  const last = requests[0]!.messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.ok(
    (last.content as Array<{ type: string }>).some((block) => block.type === "tool_result"),
    "the model resumes right after the recorded tool result",
  );
  assert.equal(promptedNote(requests), false, "no resume note reaches the model");
  assert.deepEqual(
    sink.entries.map((e) => e.type),
    ["assistant"],
    "no user entry is appended for the resumed attempt",
  );
  assert.deepEqual(
    sink.tape.filter((rec) => rec.kind === "message").map((rec) => (rec.payload as { role: string }).role),
    ["assistant"],
    "no trigger user row is taped",
  );
});

test("a compacted resume cut mid-generation after a recorded tool result continues the assistant turn", async () => {
  const summary = entry("system", { kind: "context_summary", throughSeq: 1, text: "## Goal\nList the files." }, 4);
  const thinking = entry("thinking", { thinking: "the process died here", thinkingSignature: "sig" }, 5);
  const { sink, requests } = await runResume([summary, ASK, CALL, RESULT, thinking], { continueTurn: true });
  assert.equal(promptedNote(requests), false, "no resume note reaches the model");
  assert.deepEqual(
    sink.entries.map((e) => e.type),
    ["assistant"],
  );
});

test("a resume that re-runs a retry-safe call continues the assistant turn right after the re-run result", async () => {
  const queries: string[] = [];
  const { result, sink, requests } = await runResume([ASK, SAFE_CALL], {
    continueTurn: true,
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
    sink.entries.map((e) => e.type),
    ["tool_result", "assistant"],
    "no note entry follows the re-run",
  );
  assert.deepEqual(
    sink.tape.filter((rec) => rec.kind === "message").map((rec) => (rec.payload as { role: string }).role),
    ["toolResult", "assistant"],
  );
  const flattened = JSON.stringify(requests[0]!.messages);
  assert.ok(flattened.includes("shared/q2.md"), "the model sees the re-run result");
  assert.equal(promptedNote(requests), false);
  assert.ok(!flattened.includes("[interrupted"));
});

test("a resume whose last tool call never recorded a result keeps the note path", async () => {
  const { sink, requests } = await runResume([ASK, CALL], { continueTurn: true });
  assert.equal(promptedNote(requests), true, "an unknown outcome needs the note, not a silent continue");
  assert.ok(JSON.stringify(requests[0]!.messages).includes(INTERRUPTED_TOOL_RESULT));
  assert.equal(sink.entries[0]?.type, "user", "the note is recorded as the attempt's user entry");
});

test("without the resume signal a context ending at a tool result is prompted normally", async () => {
  const { sink, requests } = await runResume([ASK, CALL, RESULT], { input: "follow-up question" });
  assert.equal(JSON.stringify(requests[0]!.messages).includes("follow-up question"), true);
  assert.equal(sink.entries[0]?.type, "user");
  assert.equal(
    sink.tape.filter((rec) => rec.kind === "message" && (rec.payload as { role: string }).role === "user").length,
    1,
    "the trigger user row is taped as usual",
  );
});

test("endsAtRecordedToolResult accepts only a real trailing tool result", () => {
  const result = { role: "toolResult", content: [{ type: "text", text: "ok" }] };
  const healed = { role: "toolResult", content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }] };
  assert.equal(endsAtRecordedToolResult([{ role: "user" }, result]), true);
  assert.equal(endsAtRecordedToolResult([{ role: "user" }, healed]), false);
  assert.equal(endsAtRecordedToolResult([{ role: "user" }, { role: "assistant" }]), false);
  assert.equal(endsAtRecordedToolResult([{ role: "user" }]), false);
  assert.equal(endsAtRecordedToolResult([]), false);
});
