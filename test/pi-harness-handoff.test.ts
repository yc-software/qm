import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { pauseStampAfterToolCall } from "../src/harness/agent-tools.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry, NewTapeRecord } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";

type Sink = { entries: Array<{ seq: number; type: string; payload: unknown }>; tape: NewTapeRecord[] };

function handoffTurn(
  sessionId: string,
  signals: { handoff: AbortSignal; handoffDeadline: AbortSignal },
  sink: Sink,
  over: Partial<HarnessTurnInput> = {},
): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    cancel: new AbortController().signal,
    ...signals,
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
    ...over,
  };
}

function abortShapedError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

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

test("a model call that outlives the handoff grace is abandoned and the turn reports itself handed off, not stopped", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const handoff = new AbortController();
  const deadline = new AbortController();
  const sink: Sink = { entries: [], tape: [] };
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
    handoff.abort();
    setTimeout(() => deadline.abort(), 100);
    const result = await harness.turns.runTurn(
      handoffTurn("handoff-deadline", { handoff: handoff.signal, handoffDeadline: deadline.signal }, sink),
    );
    assert.equal(result.handedOff, true);
    assert.equal(result.stopped, undefined, "a hand-off is not a user stop");
    assert.equal(result.reply, "");
    assert.equal(
      sink.entries.filter((entry) => entry.type === "user").length,
      1,
      "the turn's user entry is recorded once",
    );
    assert.equal(
      sink.entries.some((entry) => entry.type === "assistant"),
      false,
      "no assistant entry is fabricated for the abandoned call",
    );
    assert.equal(
      sink.tape.some(
        (rec) => rec.kind === "annotation" && (rec.payload as { subturnEnd?: unknown }).subturnEnd === true,
      ),
      false,
      "no completeness checkpoint is stamped over a handed-off segment",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a handoff requested after the model already finished lets the turn complete normally", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const handoff = new AbortController();
  const deadline = new AbortController();
  const sink: Sink = { entries: [], tape: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => sse(textReplyEvents("the finished answer"))) as typeof globalThis.fetch;
  try {
    const turn = handoffTurn("handoff-late", { handoff: handoff.signal, handoffDeadline: deadline.signal }, sink);
    turn.recordLlmRequest = () => {
      handoff.abort();
    };
    const result = await harness.turns.runTurn(turn);
    assert.equal(result.handedOff, undefined, "a finished answer is delivered, never handed off");
    assert.equal(result.reply, "the finished answer");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a continued turn resumes the recorded conversation without recording a new user entry or prompt", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [], tape: [] };
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return sse(textReplyEvents("picking up where we left off"));
  }) as typeof globalThis.fetch;
  try {
    const priorUser: SessionEntry = {
      sessionId: "handoff-continue",
      seq: 0,
      type: "user",
      payload: { text: "do the thing" },
      createdAt: Date.now() - 1_000,
      scopeLabel: "personal:tester",
    } as unknown as SessionEntry;
    const result = await harness.turns.runTurn(
      handoffTurn(
        "handoff-continue",
        { handoff: new AbortController().signal, handoffDeadline: new AbortController().signal },
        sink,
        { continueTurn: true, history: [priorUser] },
      ),
    );
    assert.equal(result.reply, "picking up where we left off");
    assert.equal(sink.entries.filter((entry) => entry.type === "user").length, 0, "no new user entry is recorded");
    assert.equal(
      sink.tape.some((rec) => rec.kind === "message" && (rec.payload as { role?: string }).role === "user"),
      false,
      "no user prompt is written to the tape",
    );
    assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0]!, /interrupted|Continue from where you left off/, "no resume note reaches the model");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a requested handoff ends the agent loop after the next tool result commits", async () => {
  const ref = { pausedOnApproval: false, silentRequested: false, runtimeHandoff: undefined, handoffRequested: false };
  const hook = pauseStampAfterToolCall(ref);
  assert.deepEqual(await hook({}), undefined);
  ref.handoffRequested = true;
  assert.deepEqual(await hook({}), { terminate: true });
});

test("an expired handoff deadline never dispatches a fresh model request", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [], tape: [] };
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return sse(textReplyEvents("must not run"));
  }) as typeof globalThis.fetch;
  try {
    const result = await harness.turns.runTurn(
      handoffTurn(
        "handoff-expired",
        {
          handoff: AbortSignal.abort(),
          handoffDeadline: AbortSignal.abort(),
        },
        sink,
      ),
    );
    assert.equal(result.handedOff, true);
    assert.equal(calls, 0);
    assert.equal(
      sink.entries.some((entry) => entry.type === "assistant"),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an active Pi model call observes a zero-grace runtime handoff", { timeout: 3000 }, async () => {
  const { createHandoff } = await import("../src/runs/handoff.ts");
  const handoff = createHandoff();
  const entered = Promise.withResolvers<void>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      entered.resolve();
      init?.signal?.addEventListener("abort", () => reject(abortShapedError()), { once: true });
    })) as typeof fetch;
  const harness = createPiHarness({ apiKey: "sk-test" });
  const signals = handoff.signals();
  try {
    const pending = harness.turns.runTurn(
      handoffTurn(
        "immediate",
        {
          handoff: signals.requested,
          handoffDeadline: signals.deadline,
        },
        { entries: [], tape: [] },
      ),
    );
    await entered.promise;
    handoff.request(0);
    assert.equal((await pending).handedOff, true);
  } finally {
    globalThis.fetch = realFetch;
    await harness.turns.close?.();
  }
});

test("a model transport that ignores abort cannot hold a deploy past its deadline", { timeout: 3000 }, async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const handoff = new AbortController();
  const deadline = new AbortController();
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<Response>();
  const sink: Sink = { entries: [], tape: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    entered.resolve();
    return pending.promise;
  }) as typeof globalThis.fetch;
  try {
    const active = harness.turns.runTurn(
      handoffTurn("handoff-uncooperative-model", { handoff: handoff.signal, handoffDeadline: deadline.signal }, sink),
    );
    await entered.promise;
    handoff.abort();
    deadline.abort();
    const result = await active;
    assert.equal(result.handedOff, true);
    assert.equal(result.stopped, undefined);
    const committed = structuredClone(sink);
    pending.resolve(sse(textReplyEvents("late provider completion")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sink, committed);
  } finally {
    globalThis.fetch = realFetch;
    pending.reject(abortShapedError());
  }
});

test("Pi commits a tool result before handoff and the incoming harness continues without replaying it", async () => {
  const retiring = createPiHarness({ apiKey: "sk-test" });
  const incoming = createPiHarness({ apiKey: "sk-test" });
  const handoff = new AbortController();
  const recorded: Sink = { entries: [], tape: [] };
  const continued: Sink = { entries: [], tape: [] };
  let reads = 0;
  const tools = {
    read: async () => {
      reads++;
      handoff.abort();
      return { content: "committed-result-unique", sourceScopeId: "personal:tester" };
    },
  } as unknown as HarnessTurnInput["tools"];
  const realFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(init?.body ?? ""));
    if (requests.length > 1) return sse(textReplyEvents("finished using the recorded result"));
    return sse([
      {
        type: "message_start",
        message: {
          id: "msg_read",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "read-one", name: "read", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "answer.txt" }) },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]);
  }) as typeof globalThis.fetch;
  try {
    const first = await retiring.turns.runTurn(
      handoffTurn(
        "handoff-tool",
        {
          handoff: handoff.signal,
          handoffDeadline: new AbortController().signal,
        },
        recorded,
        { tools },
      ),
    );
    assert.equal(first.handedOff, true);
    assert.equal(reads, 1);
    assert.equal(requests.length, 1);
    assert.ok(recorded.tape.some((row) => (row.payload as { role?: string }).role === "toolResult"));
    const next = await incoming.turns.runTurn(
      handoffTurn(
        "handoff-tool",
        {
          handoff: new AbortController().signal,
          handoffDeadline: new AbortController().signal,
        },
        continued,
        {
          tools,
          input: "",
          continueTurn: true,
          history: recorded.entries.map((entry) => ({
            ...entry,
            sessionId: "handoff-tool",
            createdAt: Date.now(),
            scopeLabel: "personal:tester",
          })) as SessionEntry[],
          tapeMode: "serve",
          tapeRows: recorded.tape.map((row, seq) => ({
            ...row,
            sessionId: "handoff-tool",
            seq,
            createdAt: Date.now(),
          })),
        },
      ),
    );
    assert.equal(next.reply, "finished using the recorded result");
    assert.equal(reads, 1);
    assert.equal(requests.length, 2);
    assert.match(requests[1]!, /committed-result-unique/);
    assert.doesNotMatch(requests[1]!, /previous attempt.*interrupted|system note:/);
    assert.equal(
      continued.entries.some((entry) => entry.type === "user"),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
