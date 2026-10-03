import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoalRecord, latestGoalRecord } from "../src/harness/goal.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry, NewTapeRecord } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";

function cancelTurn(
  sessionId: string,
  cancel: AbortSignal,
  sink: { entries: Array<{ seq: number; type: string; payload: unknown }>; tape: NewTapeRecord[] },
): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    cancel,
    input: "do the thing",
    systemPrompt: "BASE",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry: NewEntry) => {
      const appended = { ...entry, seq: seq++, createdAt: Date.now() };
      sink.entries.push({ seq: appended.seq, type: entry.type, payload: entry.payload });
      return appended as unknown as SessionEntry;
    },
    tape: async (rec: NewTapeRecord) => {
      sink.tape.push(rec);
    },
    recordModelCall: () => {},
  };
}

function abortShapedError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function hangingFetch(): typeof globalThis.fetch {
  return ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(abortShapedError());
        return;
      }
      signal?.addEventListener("abort", () => reject(abortShapedError()), { once: true });
    })) as typeof globalThis.fetch;
}

test("a mid-prompt user stop with no model text stops without inventing a reply", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  try {
    setTimeout(() => controller.abort("user"), 100);
    const result = await harness.turns.runTurn(cancelTurn("cancel-exit-stop", controller.signal, sink));
    assert.equal(result.stopped, true);
    assert.equal(result.handedOff, undefined);
    assert.equal(result.reply, "");
    assert.equal(
      sink.entries.some((entry) => entry.type === "assistant"),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

for (const reason of ["shutdown", "lease-lost", undefined]) {
  test(`a mid-prompt ${reason ?? "unlabelled"} abort hands off instead of stopping`, async () => {
    const harness = createPiHarness({ apiKey: "sk-test" });
    const controller = new AbortController();
    const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = hangingFetch();
    try {
      setTimeout(() => controller.abort(reason), 100);
      const result = await harness.turns.runTurn(cancelTurn(`cancel-exit-${reason}`, controller.signal, sink));
      assert.equal(result.handedOff, true);
      assert.equal(result.stopped, undefined);
      assert.equal(result.reply, "");
      assert.equal(
        sink.entries.some((entry) => entry.type === "assistant"),
        false,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

test("a pre-aborted shutdown hands off without calling the model", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  controller.abort("shutdown");
  const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("unexpected model call");
  }) as typeof globalThis.fetch;
  try {
    const result = await harness.turns.runTurn(cancelTurn("cancel-exit-pre", controller.signal, sink));
    assert.deepEqual(result, { reply: "", handedOff: true });
    assert.equal(calls, 0);
    assert.deepEqual(sink.entries, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

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

test("a user stop landing after the turn completed takes the normal exit", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => sse(textReplyEvents("the finished answer"))) as typeof globalThis.fetch;
  try {
    const turn = cancelTurn("cancel-after-complete", controller.signal, sink);
    turn.recordLlmRequest = () => {
      controller.abort("user");
    };
    const result = await harness.turns.runTurn(turn);
    assert.equal(result.stopped, undefined, "a completed turn is never rewritten into a stopped one");
    assert.equal(result.reply, "the finished answer");
    assert.equal(
      sink.entries.some(
        (entry) => entry.type === "assistant" && (entry.payload as { text?: unknown }).text === "(stopped)",
      ),
      false,
      "no fabricated stopped partial",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Pi hands off a shutdown cancel without pausing its active goal", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    controller.abort("shutdown");
    throw abortShapedError();
  }) as typeof globalThis.fetch;
  const goal = createGoalRecord({
    objective: "resume after restart",
    floor: { minMs: 32_400_000 },
    capTokens: 50_000,
  });
  goal.tokensUsed = 1234;
  try {
    const turn = cancelTurn("cancel-rehydrated-goal", controller.signal, sink);
    turn.history = [
      {
        type: "tool_result",
        payload: { tool: "goal", action: "create", goal },
        seq: 0,
        sessionId: turn.session.id,
        parentSeq: null,
        createdAt: 1,
        scopeLabel: turn.scopeLabel,
      },
    ];
    const result = await harness.turns.runTurn(turn);
    assert.equal(result.handedOff, true);
    assert.equal(result.stopped, undefined);
    assert.notEqual(latestGoalRecord(sink.entries)?.status, "paused");
  } finally {
    globalThis.fetch = realFetch;
  }
});
