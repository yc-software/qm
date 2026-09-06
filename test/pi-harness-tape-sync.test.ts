import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry, NewTapeRecord } from "../src/sessions/session-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

type Sink = {
  entries: Array<{ seq: number; type: string; payload: unknown }>;
  tape: NewTapeRecord[];
};

function turnInput(sessionId: string, sink: Sink, overrides: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
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

function gatedSse(events: Array<Record<string, unknown>>, gate: Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events.slice(0, -1)) {
        controller.enqueue(encoder.encode(`event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`));
      }
      await gate;
      const last = events.at(-1)!;
      controller.enqueue(encoder.encode(`event: ${last.type as string}\ndata: ${JSON.stringify(last)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("tape rows land synchronously in consumption order, steers at their injection point", async () => {
  const signals = createMemoryRunSignalStore();
  const harness = createPiHarness({ apiKey: "sk-test", signals });
  const sink: Sink = { entries: [], tape: [] };
  let releaseFirstStep = () => {};
  const steerQueued = new Promise<void>((resolve) => {
    releaseFirstStep = () => setTimeout(resolve, 50);
  });
  const tapeRowsAtDispatch: number[] = [];
  const requestMessages: Array<Array<{ role: string }>> = [];
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    tapeRowsAtDispatch.push(sink.tape.filter((rec) => rec.kind === "message").length);
    requestMessages.push((JSON.parse(String(init?.body ?? "{}")) as { messages?: [] }).messages ?? []);
    if (calls === 1) return gatedSse(textReplyEvents("first step"), steerQueued);
    return sse(textReplyEvents("final reply"));
  }) as typeof globalThis.fetch;
  try {
    const turn = turnInput("tape-order", sink, { runId: "run-order" });
    const emit = turn.emit;
    turn.emit = async (entry) => {
      const appended = await emit(entry);
      if (entry.type === "user" && (entry.payload as { steered?: unknown }).steered === true) releaseFirstStep();
      return appended;
    };
    setTimeout(() => {
      void signals.send("run-order", { kind: "steer", text: "actually, do it differently", ts: "1712.001" });
    }, 30);
    const result = await harness.turns.runTurn(turn);
    assert.equal(result.reply, "final reply");

    const messageRows = sink.tape.filter((rec) => rec.kind === "message");
    assert.deepEqual(
      messageRows.map((rec) => (rec.payload as { role: string }).role),
      ["user", "assistant", "user", "assistant"],
      "the tape holds exactly the consumed messages, in consumption order",
    );
    assert.equal(messageRows[0]!.meta?.bareText, "do the thing");
    assert.equal(messageRows[2]!.meta?.bareText, "actually, do it differently");
    assert.equal(messageRows[2]!.meta?.ts, "1712.001", "the steer row is stamped with its arrival ts");
    assert.equal(calls, 2);
    assert.equal(tapeRowsAtDispatch[0], 1, "the trigger user row is committed before the first dispatch");
    assert.equal(
      tapeRowsAtDispatch[1],
      3,
      "step 2 is not dispatched until the trigger, first reply, and injected steer are all on the tape",
    );
    assert.deepEqual(
      requestMessages[1]!.map((message) => message.role),
      ["user", "assistant", "user"],
      "the steer was injected into the model context exactly where the tape says",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed tape append fails the turn loudly with the append error, no checkpoint", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [], tape: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => sse(textReplyEvents("a reply that must not survive"))) as typeof globalThis.fetch;
  try {
    const turn = turnInput("tape-fatal", sink, {
      tape: async (rec: NewTapeRecord) => {
        if (rec.kind === "message" && (rec.payload as { role?: string }).role === "assistant")
          throw new Error("tape insert refused");
        sink.tape.push(rec);
      },
    });
    await assert.rejects(harness.turns.runTurn(turn), /tape insert refused/);
    assert.equal(
      sink.tape.some((rec) => rec.kind === "annotation" && (rec.payload as { subturnEnd?: unknown }).subturnEnd),
      false,
      "no completeness checkpoint is stamped over the failure",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a lease lost mid-turn fails the turn instead of degrading silently", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const sink: Sink = { entries: [], tape: [] };
  const store = createMemorySessionStore();
  const session = await store.getOrCreateByThread("dm:lease-lost", "dm", "personal:tester" as ScopeId);
  const attempt = await store.acquireLease(session.id, "turn");
  const lease = attempt.lease!;
  assert.ok(lease);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    await store.releaseLease(lease);
    const thief = await store.acquireLease(session.id, "turn");
    assert.ok(thief.lease);
    return sse(textReplyEvents("reply after the lease was stolen"));
  }) as typeof globalThis.fetch;
  try {
    const turn = turnInput(session.id, sink, {
      tape: (rec: NewTapeRecord) => store.appendTape(lease, rec),
    });
    await assert.rejects(harness.turns.runTurn(turn), /without a valid session lease/);
    assert.equal(await store.tapeCoverage(session.id), -1, "nothing on the stolen-lease tape claims coverage");
  } finally {
    globalThis.fetch = realFetch;
  }
});
