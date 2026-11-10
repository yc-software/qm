import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agent/agent-run.ts";
import { approvedCallsOnEarlierAttempt } from "../src/core/orchestrator/approvals.ts";
import { createModelRoutes } from "../src/model/model-route.ts";
import type { AgentTurnInput, SteeredApproval } from "../src/agent/agent.ts";
import type { Item, NewItem } from "../src/sessions/items.ts";
import { DuplicateCallError } from "../src/sessions/session-store.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import type { ScopeId, TurnRequest } from "../src/types.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

type Sink = Item[];
type ProviderMessage = { role: string; content: Array<Record<string, unknown>> | string };

const scope = "personal:tester" as ScopeId;

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function gatedSse(events: Array<Record<string, unknown>>, gate: Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events.slice(0, -1))
        controller.enqueue(encoder.encode(`event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`));
      await gate;
      const last = events.at(-1)!;
      controller.enqueue(encoder.encode(`event: ${last.type as string}\ndata: ${JSON.stringify(last)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
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

function turnInput(sessionId: string, sink: Sink, overrides: Partial<AgentTurnInput>): AgentTurnInput {
  let seq = 1;
  return {
    session: { id: sessionId } as AgentTurnInput["session"],
    input: "carry on",
    systemPrompt: "BASE",
    history: [],
    tools: {} as ToolContext,
    scopeLabel: scope,
    orgScopeId: "org:test" as ScopeId,
    emit: async (item: NewItem) => {
      const stored = { body: {}, ...item, sessionId, seq: seq++, createdAt: Date.now() } as Item;
      sink.push(stored);
      return stored;
    },
    recordModelCall: () => {},
    ...overrides,
  };
}

function toolResults(messages: ProviderMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((block) => block.type === "tool_result") : [],
  );
}

test("an approved call runs once, exactly as stored, before the model sees the approval turn", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = [];
  const queries: string[] = [];
  const requests: ProviderMessage[][] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push((JSON.parse(String(init?.body ?? "{}")) as { messages?: ProviderMessage[] }).messages ?? []);
    return sse(textReplyEvents("the reminder is scheduled"));
  }) as typeof globalThis.fetch;
  try {
    const result = await agent.runTurn(
      turnInput("approved-pre", sink, {
        input: "(approval note)",
        tools: {
          async history(q: string) {
            queries.push(q);
            return ["user#1: reminder goes out at noon Taipei time"];
          },
        } as unknown as ToolContext,
        approvedToolCalls: [
          {
            callId: "approved_req1_ab12",
            requestId: "req1",
            tool: "history",
            input: { query: "noon" },
          },
        ],
      }),
    );
    assert.equal(result.reply, "the reminder is scheduled");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(queries, ["noon"], "the stored arguments ran once; the model did not re-propose them");
  assert.deepEqual(
    sink.slice(0, 2).map((item) => item.kind),
    ["ToolCall", "ToolResult"],
  );
  for (const item of sink.slice(0, 2)) {
    assert.equal(item.callId, "approved_req1_ab12");
    assert.equal(item.body.approvedRequestId, "req1");
  }
  assert.equal(requests.length, 1);
  const flattened = JSON.stringify(requests[0]);
  const resultAt = flattened.indexOf("noon Taipei time");
  assert.ok(resultAt > 0, "the approved call's result reaches the model");
  assert.ok(flattened.indexOf("(approval note)") > resultAt, "the result precedes the approval turn's note");
  assert.equal(toolResults(requests[0]!).length, 1);
});

test("an approved call whose tool is missing records an error result instead of failing the turn", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => sse(textReplyEvents("noted"))) as typeof globalThis.fetch;
  try {
    await agent.runTurn(
      turnInput("approved-missing", sink, {
        readOnly: true,
        approvedToolCalls: [{ callId: "approved_req9_cd34", requestId: "req9", tool: "no_such_tool", input: {} }],
      }),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  const result = sink.find((item) => item.kind === "ToolResult");
  assert.ok(result);
  assert.equal(result.isError, true);
  assert.match(String(result.text), /not available on this turn/);
});

test("an approved call whose call id is already recorded does not run again", async () => {
  const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }) });
  const sink: Sink = [];
  const queries: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => sse(textReplyEvents("noted"))) as typeof globalThis.fetch;
  const call = { callId: "approved_req5_1700", requestId: "req5", tool: "history", input: { query: "noon" } };
  try {
    const base = turnInput("approved-dup", sink, {});
    await agent.runTurn({
      ...base,
      tools: {
        async history(q: string) {
          queries.push(q);
          return ["ran"];
        },
      } as unknown as ToolContext,
      approvedToolCalls: [call],
      emit: async (item) => {
        if (item.kind === "ToolCall" && item.callId === call.callId)
          throw new DuplicateCallError("approved-dup", [call.callId]);
        return base.emit(item);
      },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(queries, [], "the database's one-call-per-id rule stops a second run before the tool executes");
});

function approvalRequest(requestId: string, approved: boolean): TurnRequest {
  return {
    surface: "slack",
    actor: { externalId: "U1", displayName: "Gabrielle" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text: "make the reminder",
    approval: { requestId, approved, ...(approved ? { scope: "once" as const } : {}) },
  };
}

for (const approved of [true, false]) {
  test(`a ${approved ? "approval" : "denial"} clicked during a live run reaches that run's model`, async () => {
    const signals = createPostgresRunSignalStore(testDatabaseUrl());
    const agent = createAgent({ routes: createModelRoutes({ apiKey: "sk-test" }), signals });
    const runId = `run-live-approval-${approved}-${randomUUID()}`;
    const sink: Sink = [];
    const queries: string[] = [];
    const requests: ProviderMessage[][] = [];
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const decided: TurnRequest[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push((JSON.parse(String(init?.body ?? "{}")) as { messages?: ProviderMessage[] }).messages ?? []);
      if (requests.length === 1) {
        setTimeout(() => {
          void signals.send(runId, {
            kind: "steer",
            text: "[approval decision]",
            ts: "approval:req2",
            dedupeKey: `approval:${runId}`,
            request: approvalRequest("req2", approved),
          });
        }, 30);
        return gatedSse(textReplyEvents("looking at the sheet"), released);
      }
      return sse(textReplyEvents("all set"));
    }) as typeof globalThis.fetch;
    try {
      const result = await agent.runTurn(
        turnInput(`live-${approved}`, sink, {
          runId,
          tools: {
            async history(q: string) {
              queries.push(q);
              return ["user#4: reminder created as push 18767"];
            },
          } as unknown as ToolContext,
          resolveSteeredApproval: async (request): Promise<SteeredApproval> => {
            decided.push(request);
            setTimeout(release, 200);
            if (!request.approval?.approved) return { kind: "denied", summary: "history", approver: "Gabrielle" };
            return {
              kind: "run",
              summary: "history",
              approver: "Gabrielle",
              call: { callId: "approved_req2_ef56", requestId: "req2", tool: "history", input: { query: "push" } },
            };
          },
        }),
      );
      assert.equal(result.reply, "all set");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(decided.length, 1, "the decision is resolved once");
    assert.deepEqual(queries, approved ? ["push"] : [], approved ? "the approved call ran once" : "nothing ran");
    assert.deepEqual(await signals.takePending(runId), [], "the decision signal is acknowledged");
    assert.equal(requests.length, 2);
    const followUp = JSON.stringify(requests[1]);
    if (approved) {
      assert.match(followUp, /push 18767/);
      const recorded = sink.filter((item) => item.body.approvedRequestId === "req2");
      assert.deepEqual(
        recorded.map((item) => item.kind),
        ["ToolCall", "ToolResult"],
      );
      const notes = sink.filter((item) => item.kind === "Wake");
      assert.equal(notes.length, 1, "the live note is recorded once");
      assert.doesNotMatch(JSON.stringify(notes[0]), /push 18767/, "the recorded note does not repeat the result");
    } else {
      assert.doesNotMatch(followUp, /push 18767/, "nothing ran, so no result reaches the model");
      assert.ok(!sink.some((item) => item.kind === "ToolCall"));
    }
  });
}

test("a retried turn only finishes approved calls the same person decided", () => {
  const call = { callId: "approved_req3_ef01", requestId: "req3", tool: "history", input: { query: "noon" } };
  const decided = {
    sessionId: "s",
    createdAt: 1,
    seq: 1,
    kind: "ElicitationResponse",
    elicitId: "req3",
    approved: true,
    author: "U1",
    body: { command: "history", scope: "once", call, approvalKey: "tool-call:abc" },
  } as unknown as Item;
  assert.equal(approvedCallsOnEarlierAttempt([decided], "U2").unstarted.length, 0);
  assert.deepEqual(approvedCallsOnEarlierAttempt([decided], "U1").unstarted, [{ call, approvalKey: "tool-call:abc" }]);
});
