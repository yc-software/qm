import { test } from "node:test";
import assert from "node:assert/strict";
import { findTrailingPartialTurn, resumeStrategy, turnAtSeq } from "../src/core/turn-resume.ts";
import { createGoalRecord, latestGoalRecord } from "../src/harness/goal.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry, NewTapeRecord } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";

function cancelTurn(
  sessionId: string,
  cancel: AbortSignal,
  sink: { entries: Array<{ seq: number; type: string; payload: unknown }>; tape: NewTapeRecord[] },
  overrides: Partial<HarnessTurnInput> = {},
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
    ...overrides,
  };
}

function abortShapedError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

test("a mid-prompt cancel takes the stopped exit: partial persisted replay-safe, checkpointed, attested", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(abortShapedError());
        return;
      }
      signal?.addEventListener("abort", () => reject(abortShapedError()), { once: true });
    })) as typeof globalThis.fetch;
  try {
    setTimeout(() => controller.abort(), 100);
    const result = await harness.turns.runTurn(cancelTurn("cancel-exit-stop", controller.signal, sink));

    assert.equal(result.stopped, true, "the cancelled turn reports itself stopped");
    assert.equal(result.stoppedTapeComplete, true, "…and attests its tape is complete");
    assert.equal(result.reply, "(stopped)");
    const finalEntry = sink.entries.at(-1);
    assert.equal(finalEntry?.type, "assistant");
    assert.equal((finalEntry?.payload as { text?: unknown } | undefined)?.text, "(stopped)");
    assert.equal((finalEntry?.payload as { stopped?: boolean } | undefined)?.stopped, true);
    const cleanPartial = sink.tape.find(
      (rec) =>
        rec.kind === "message" &&
        (rec.payload as { role?: string; stopReason?: string }).role === "assistant" &&
        (rec.payload as { stopReason?: string }).stopReason === "stop",
    );
    assert.ok(cleanPartial, "the partial is re-taped as a replay-visible message");
    const checkpoint = sink.tape.find(
      (rec) => rec.kind === "annotation" && (rec.payload as { subturnEnd?: unknown }).subturnEnd === true,
    );
    assert.ok(checkpoint, "the stopped sub-turn is checkpointed");
    assert.equal(checkpoint!.entrySeq, finalEntry!.seq, "…at the final assistant entry");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a genuine provider error racing a cancel still fails the turn instead of completing it as stopped", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  controller.abort();
  const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "boom" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      harness.turns.runTurn(cancelTurn("cancel-exit-error", controller.signal, sink)),
      /boom|400|invalid_request_error/,
      "the unrelated failure surfaces as a turn error, not a stopped completion",
    );
    assert.equal(
      sink.entries.some(
        (entry) => entry.type === "assistant" && (entry.payload as { text?: unknown }).text === "(stopped)",
      ),
      false,
      "no stopped partial is fabricated for a turn that genuinely failed",
    );
    assert.equal(
      sink.tape.some(
        (rec) => rec.kind === "annotation" && (rec.payload as { subturnEnd?: unknown }).subturnEnd === true,
      ),
      false,
      "no completeness checkpoint is stamped over the failure",
    );
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

test("a cancel landing after the turn completed takes the normal exit, not the stopped hijack", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => sse(textReplyEvents("the finished answer"))) as typeof globalThis.fetch;
  try {
    const turn = cancelTurn("cancel-after-complete", controller.signal, sink);
    turn.recordLlmRequest = () => {
      controller.abort();
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

test("a second '(stopped)' in one session is still re-taped for replay", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(abortShapedError());
        return;
      }
      signal?.addEventListener("abort", () => reject(abortShapedError()), { once: true });
    })) as typeof globalThis.fetch;
  try {
    const turn = cancelTurn("cancel-second-stopped", controller.signal, sink);
    turn.history = [
      {
        sessionId: "cancel-second-stopped",
        seq: 0,
        parentSeq: null,
        type: "user",
        payload: { text: "earlier ask" },
        scopeLabel: turn.scopeLabel,
        createdAt: 1,
      },
      {
        sessionId: "cancel-second-stopped",
        seq: 1,
        parentSeq: 0,
        type: "assistant",
        payload: { text: "(stopped)" },
        scopeLabel: turn.scopeLabel,
        createdAt: 2,
      },
    ];
    setTimeout(() => controller.abort(), 100);
    const result = await harness.turns.runTurn(turn);
    assert.equal(result.stopped, true);
    assert.equal(result.stoppedTapeComplete, true);
    const retaped = sink.tape.filter(
      (rec) =>
        rec.kind === "message" &&
        (rec.payload as { role?: string; stopReason?: string }).role === "assistant" &&
        (rec.payload as { stopReason?: string }).stopReason === "stop" &&
        JSON.stringify((rec.payload as { content?: unknown }).content).includes("(stopped)"),
    );
    assert.equal(
      retaped.length,
      1,
      "the prior turn's identical text must not suppress this turn's replay-visible re-tape",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Pi rehydrates a durable receipt and preserves its active goal when the worker cancels", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    controller.abort();
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
    assert.equal(result.stopped, true);
    const { activeMs, ...persisted } = latestGoalRecord(sink.entries)!;
    assert.deepEqual(persisted, goal);
    assert.ok(activeMs! >= 0 && activeMs! < 60_000, "the cancelled turn banks only its own running time");
  } finally {
    globalThis.fetch = realFetch;
  }
});

function toolUseEvents(): Array<Record<string, unknown>> {
  const events = textReplyEvents("");
  events[1] = {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "read-memory", name: "memory", input: {} },
  };
  events[2] = {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify({ action: "read" }) },
  };
  events[4] = { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } };
  return events;
}

for (const shutdown of [false, true]) {
  test(`a cancel mid-tool ${shutdown ? "from shutdown leaves the turn open for resume" : "without shutdown records the stop marker"}`, async () => {
    const harness = createPiHarness({ apiKey: "sk-test" });
    const cancel = new AbortController();
    const shutdownSignal = new AbortController();
    const sink = { entries: [] as Array<{ seq: number; type: string; payload: unknown }>, tape: [] as NewTapeRecord[] };
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      if (++calls === 1) return Promise.resolve(sse(toolUseEvents()));
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(abortShapedError());
          return;
        }
        signal?.addEventListener("abort", () => reject(abortShapedError()), { once: true });
      });
    }) as typeof globalThis.fetch;
    try {
      const turn = cancelTurn("cancel-mid-tool", cancel.signal, sink, {
        readOnly: false,
        shutdown: shutdownSignal.signal,
        tools: {
          memoryRead: async () => {
            if (shutdown) shutdownSignal.abort();
            cancel.abort();
            await new Promise((resolve) => setTimeout(resolve, 20));
            return "remembered facts";
          },
        } as unknown as HarnessTurnInput["tools"],
      });
      const result = await harness.turns.runTurn(turn);
      assert.equal(result.stopped, true);
      assert.equal(result.stoppedTapeComplete, true);
      const entries = sink.entries as unknown as SessionEntry[];
      const types = entries.map((entry) => entry.type);
      assert.deepEqual(types.slice(0, 3), ["user", "tool_call", "tool_result"]);
      const stoppedEntries = entries.filter((entry) => entry.type === "assistant");
      const stoppedTape = sink.tape.filter(
        (rec) =>
          rec.kind === "message" &&
          (rec.payload as { role?: string; stopReason?: string }).role === "assistant" &&
          (rec.payload as { stopReason?: string }).stopReason === "stop",
      );
      const checkpoints = sink.tape.filter(
        (rec) => rec.kind === "annotation" && (rec.payload as { subturnEnd?: unknown }).subturnEnd === true,
      );
      const partial = findTrailingPartialTurn(entries, "do the thing");
      if (shutdown) {
        assert.deepEqual(stoppedEntries, [], "shutdown must not close the turn with a stop marker");
        assert.deepEqual(stoppedTape, [], "…nor re-tape one for replay");
        assert.deepEqual(checkpoints, []);
        assert.equal((entries[2]!.payload as { interrupted?: unknown }).interrupted, true);
        assert.ok(partial, "the resumed attempt finds the open turn");
        assert.notEqual(resumeStrategy(entries, partial).kind, "restart");
        assert.equal(turnAtSeq(entries, partial.userSeq)?.answer, undefined);
      } else {
        assert.equal(stoppedEntries.length, 1);
        assert.equal((stoppedEntries[0]!.payload as { text?: unknown }).text, "(stopped)");
        assert.equal(stoppedTape.length, 1);
        assert.equal(checkpoints.length, 1);
        assert.equal(partial, null, "a user-facing stop closes the turn");
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}
