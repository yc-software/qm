import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
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

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolUseEvents(command: string): Array<Record<string, unknown>> {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_tool",
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
      content_block: { type: "tool_use", id: "call1", name: "execute", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, purpose: "test" }) },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
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

for (const withSteer of [false, true])
  test(`handoff to a fresh worker${withSteer ? " with a queued steer" : ""} resumes after the committed tool`, async () => {
    const signals = createMemoryRunSignalStore();
    let harness = createPiHarness({ apiKey: "sk-test", signals });
    const handoff = new AbortController();
    const sink: Sink = { entries: [], tape: [] };
    const realFetch = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return sse(bodies.length === 1 ? toolUseEvents("make build") : textReplyEvents("picking up where we left off"));
    }) as typeof globalThis.fetch;
    const tools = {
      execute: async () => {
        handoff.abort();
        if (withSteer) {
          await signals.send("safe-point-run", { kind: "steer", text: "also check the build output", ts: "steer-1" });
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { stdout: "built", stderr: "", code: 0, timedOut: false };
      },
      sessionSyscalls: { receive: async () => [], acknowledge: async () => {} },
    } as unknown as HarnessTurnInput["tools"];
    try {
      const first = await harness.turns.runTurn(
        handoffTurn("safe-point", { handoff: handoff.signal, handoffDeadline: new AbortController().signal }, sink, {
          tools,
          runId: "safe-point-run",
        }),
      );
      assert.equal(first.handedOff, true);
      assert.equal(first.stopped, undefined);
      assert.equal(bodies.length, 1);
      assert.deepEqual(
        sink.entries.map((entry) => entry.type),
        ["user", "tool_call", "tool_result"],
      );
      const history = sink.entries.map(
        (entry) =>
          ({
            ...entry,
            sessionId: "safe-point",
            createdAt: Date.now(),
            scopeLabel: "personal:tester",
          }) as unknown as SessionEntry,
      );
      assert.equal((await signals.pending("safe-point-run")).length, withSteer ? 1 : 0);
      await harness.turns.close?.();
      harness = createPiHarness({ apiKey: "sk-test", signals });
      const resumed: Sink = { entries: [], tape: [] };
      const second = await harness.turns.runTurn(
        handoffTurn(
          "safe-point",
          { handoff: new AbortController().signal, handoffDeadline: new AbortController().signal },
          resumed,
          { tools, continueTurn: true, history, runId: "safe-point-run" },
        ),
      );
      assert.equal(second.reply, "picking up where we left off");
      assert.equal(resumed.entries.filter((entry) => entry.type === "user").length, withSteer ? 1 : 0);
      assert.equal((await signals.pending("safe-point-run")).length, 0);
      if (withSteer) assert.ok(bodies.some((body) => body.includes("also check the build output")));
      assert.match(bodies[1]!, /built/);
      assert.doesNotMatch(bodies[1]!, /interrupted|Continue from where you left off/);
    } finally {
      globalThis.fetch = realFetch;
      await harness.turns.close?.();
    }
  });

test(
  "a command still running at the deadline leaves its outcome unrecorded and consumes no mail",
  { timeout: 5000 },
  async () => {
    const harness = createPiHarness({ apiKey: "sk-test" });
    const handoff = new AbortController();
    const deadline = new AbortController();
    const entered = Promise.withResolvers<void>();
    const finishCommand = Promise.withResolvers<{ stdout: string; stderr: string; code: number; timedOut: boolean }>();
    const cleanup = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    const sink: Sink = { entries: [], tape: [] };
    const realFetch = globalThis.fetch;
    let acknowledgments = 0;
    globalThis.fetch = (async () =>
      sse([
        {
          type: "message_start",
          message: {
            id: "msg_write",
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
          content_block: { type: "tool_use", id: "write1", name: "execute", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ command: "external-write", purpose: "test" }),
          },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ])) as typeof fetch;
    try {
      const pending = harness.turns.runTurn(
        handoffTurn("late-command", { handoff: handoff.signal, handoffDeadline: deadline.signal }, sink, {
          turnWallClockMs: 0,
          tools: {
            execute: async () => {
              entered.resolve();
              return finishCommand.promise;
            },
            sessionSyscalls: {
              receive: async () => [{ id: "new-mail", text: "new worker message" }],
              acknowledge: async () => {
                acknowledgments++;
              },
            },
          } as unknown as HarnessTurnInput["tools"],
          recordLlmRequest: async () => {
            cleanup.resolve();
            await finishCleanup.promise;
          },
        }),
      );
      await entered.promise;
      handoff.abort();
      deadline.abort();
      await cleanup.promise;
      const before = sink.entries.length;
      finishCommand.resolve({ stdout: "completed remotely", stderr: "", code: 0, timedOut: false });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(sink.entries.length, before);
      assert.equal(acknowledgments, 0);
      finishCleanup.resolve();
      assert.equal((await pending).handedOff, true);
      assert.equal(sink.entries.filter((entry) => entry.type === "tool_call").length, 1);
      assert.equal(sink.entries.filter((entry) => entry.type === "tool_result").length, 0);
    } finally {
      globalThis.fetch = realFetch;
      finishCleanup.resolve();
      finishCommand.resolve({ stdout: "", stderr: "", code: 0, timedOut: false });
      await harness.turns.close?.();
    }
  },
);
