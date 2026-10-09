import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry, NewTapeRecord, TapeRecord } from "../src/sessions/session-store.ts";
import { foldTape } from "../src/harness/tape-fold.ts";
import { zeroUsage } from "../src/harness/replay.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textReplyEvents(text: string): Array<Record<string, unknown>> {
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
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
}

const scope = "personal:tester" as ScopeId;
const NOTE = "(system note: your previous attempt at the request above was paused mid-turn and has resumed.)";

test("the pi harness re-runs a retry-safe interrupted call before the model sees the resumed turn", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const entries: Array<{ seq: number; type: string; payload: unknown }> = [];
  const tape: NewTapeRecord[] = [];
  const queries: string[] = [];
  const requests: Array<Array<{ role: string; content: Array<Record<string, unknown>> | string }>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: (typeof requests)[number] };
    requests.push(body.messages ?? []);
    return sse(textReplyEvents("we kept the Q2 budget flat"));
  }) as typeof globalThis.fetch;
  const history: SessionEntry[] = [
    {
      sessionId: "s1",
      seq: 1,
      parentSeq: null,
      type: "user",
      payload: { text: "what about the budget?" },
      scopeLabel: scope,
      createdAt: 1,
    },
    {
      sessionId: "s1",
      seq: 2,
      parentSeq: null,
      type: "tool_call",
      payload: {
        tool: "history",
        query: "budget",
        callId: "c-budget",
        retrySafe: true,
        rerun: { tool: "history", input: { query: "budget" } },
      },
      scopeLabel: scope,
      createdAt: 2,
    },
  ];
  let seq = 3;
  const tapeRow = (payload: unknown, i: number): TapeRecord =>
    ({
      sessionId: "s1",
      seq: i,
      kind: "message",
      harness: "pi",
      payload,
      scopeLabel: scope,
      createdAt: i,
    }) as TapeRecord;
  const servedRows = [
    { role: "user", content: [{ type: "text", text: "what about the budget?" }], timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c-budget", name: "history", arguments: { query: "budget", retrySafe: true } }],
      stopReason: "toolUse",
      timestamp: 2,
      usage: zeroUsage(),
    },
    {
      role: "toolResult",
      toolCallId: "c-budget",
      toolName: "history",
      content: [{ type: "text", text: "[exit 143]" }],
      isError: false,
      interrupted: true,
      timestamp: 3,
    },
    { role: "assistant", content: [], stopReason: "aborted", timestamp: 4, usage: zeroUsage() },
    {
      role: "assistant",
      content: [{ type: "text", text: "(stopped)" }],
      stopReason: "stop",
      timestamp: 5,
      usage: zeroUsage(),
    },
  ].map(tapeRow);
  const turn: HarnessTurnInput = {
    session: { id: "s1" } as HarnessTurnInput["session"],
    input: NOTE,
    systemPrompt: "BASE",
    history,
    tapeRows: servedRows,
    tapeMode: "serve",
    tapeFold: foldTape(servedRows),
    tools: {
      async history(q: string) {
        queries.push(q);
        return ["user#1: the budget doc is in shared/q2.md"];
      },
    } as unknown as ToolContext,
    scopeLabel: scope,
    orgScopeId: "org:test" as ScopeId,
    resumeToolCall: { callId: "c-budget", tool: "history", input: { query: "budget" } },
    emit: async (entry: NewEntry) => {
      const appended = { ...entry, sessionId: "s1", parentSeq: null, seq: seq++, createdAt: Date.now() };
      entries.push({ seq: appended.seq, type: entry.type, payload: entry.payload });
      return appended as SessionEntry;
    },
    tape: async (rec: NewTapeRecord) => {
      tape.push(rec);
    },
    recordModelCall: () => {},
  };
  try {
    const result = await harness.turns.runTurn(turn);
    assert.equal(result.reply, "we kept the Q2 budget flat");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(queries, ["budget"], "the interrupted call ran exactly once");
  assert.deepEqual(
    entries.map((e) => e.type),
    ["tool_result", "user", "assistant"],
    "the result closes the dangling call before this attempt's note is recorded; no second tool_call",
  );
  assert.equal((entries[0]!.payload as { callId: string }).callId, "c-budget");

  const roles = tape.filter((rec) => rec.kind === "message").map((rec) => (rec.payload as { role: string }).role);
  assert.deepEqual(roles, ["toolResult", "user", "assistant"], "the tape closes the call before the trigger row");
  const taped = tape.find((rec) => (rec.payload as { role?: string }).role === "toolResult")!.payload as {
    toolCallId: string;
    content: Array<{ text: string }>;
    isError: boolean;
  };
  assert.equal(taped.toolCallId, "c-budget");
  assert.equal(taped.isError, false);
  assert.match(taped.content[0]!.text, /shared\/q2\.md/);

  assert.equal(requests.length, 1);
  const flattened = JSON.stringify(requests[0]);
  assert.ok(!flattened.includes("[interrupted"), "the model never sees an interrupted placeholder");
  assert.ok(!flattened.includes("[exit 143]"), "the killed attempt's text is gone from the served fold");
  const resultAt = flattened.indexOf("shared/q2.md");
  const stoppedAt = flattened.indexOf("(stopped)");
  const noteAt = flattened.indexOf("paused mid-turn and has resumed");
  assert.ok(resultAt > 0 && stoppedAt > resultAt, "the re-run result sits beside its call, before the stop message");
  assert.ok(noteAt > resultAt, "the real tool result precedes the resume note in the model's context");
  const toolResults = requests[0]!.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((block) => block.type === "tool_result") : [],
  );
  assert.equal(toolResults.length, 1, "exactly one tool_result reaches the provider for the retried call");
});
