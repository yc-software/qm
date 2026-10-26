import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { ScopeId } from "../src/types.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

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
  const entries: Item[] = [];
  const queries: string[] = [];
  const requests: Array<Array<{ role: string; content: Array<Record<string, unknown>> | string }>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: (typeof requests)[number] };
    requests.push(body.messages ?? []);
    return sse(textReplyEvents("we kept the Q2 budget flat"));
  }) as typeof globalThis.fetch;
  const history: Item[] = [
    storedItem({ kind: "UserMessage", text: "what about the budget?" }, { sessionId: "s1", seq: 1, createdAt: 1 }),
    storedItem(
      {
        kind: "ToolCall",
        tool: "history",
        callId: "c-budget",
        body: { query: "budget", retrySafe: true, rerun: { tool: "history", input: { query: "budget" } } },
      },
      { sessionId: "s1", seq: 2, createdAt: 2 },
    ),
  ];
  let seq = 3;
  const turn: HarnessTurnInput = {
    session: { id: "s1" } as HarnessTurnInput["session"],
    input: NOTE,
    systemPrompt: "BASE",
    history,
    tools: {
      async history(q: string) {
        queries.push(q);
        return ["UserMessage#1: the budget doc is in shared/q2.md"];
      },
    } as unknown as ToolContext,
    scopeLabel: scope,
    orgScopeId: "org:test" as ScopeId,
    resumeToolCall: { callId: "c-budget", tool: "history", input: { query: "budget" } },
    emit: async (item: NewItem) => {
      const appended = storedItem(item, { sessionId: "s1", seq: seq++, createdAt: Date.now() });
      entries.push(appended);
      return appended;
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
    entries.map((e) => e.kind),
    ["ToolResult", "UserMessage", "AgentMessage"],
    "the result closes the dangling call before this attempt's note is recorded; no second tool call",
  );
  assert.equal(entries[0]!.callId, "c-budget");

  assert.equal(requests.length, 1);
  const flattened = JSON.stringify(requests[0]);
  assert.ok(!flattened.includes("[interrupted"), "the model never sees an interrupted placeholder");
  const resultAt = flattened.indexOf("shared/q2.md");
  const noteAt = flattened.indexOf("paused mid-turn and has resumed");
  assert.ok(resultAt > 0, "the re-run result reaches the model");
  assert.ok(noteAt > resultAt, "the real tool result precedes the resume note in the model's context");
  const toolResults = requests[0]!.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((block) => block.type === "tool_result") : [],
  );
  assert.equal(toolResults.length, 1, "exactly one tool_result reaches the provider for the retried call");
});
