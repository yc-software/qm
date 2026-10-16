import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoalRecord, type GoalRecord } from "../src/harness/goal.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { ProviderTurnError } from "../src/core/turn-error.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";

const sessionGoals = new Map<string, GoalRecord>();
const savedGoal = (sessionId: string) => sessionGoals.get(sessionId) ?? null;

function goalTurn(
  sessionId: string,
  cancel: AbortSignal,
  entries: Array<{ type: string; payload: unknown }>,
): HarnessTurnInput {
  let seq = 0;
  const goal = createGoalRecord({ objective: "keep researching until done" });
  return {
    session: { id: sessionId } as HarnessTurnInput["session"],
    cancel,
    input: "continue",
    systemPrompt: "BASE",
    history: [],
    goal,
    saveGoal: async (record) => {
      sessionGoals.set(sessionId, structuredClone(record));
    },
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
    orgScopeId: "org:test" as HarnessTurnInput["orgScopeId"],
    emit: async (entry: NewEntry) => {
      entries.push({ type: entry.type, payload: entry.payload });
      return { ...entry, seq: ++seq, createdAt: Date.now() } as unknown as SessionEntry;
    },
    recordModelCall: () => {},
  };
}

test("an active goal stops continuing once a model round fails at the provider", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const entries: Array<{ type: string; payload: unknown }> = [];
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests > 5) controller.abort();
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "Your credit balance is too low." },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  try {
    const outcome = await harness.turns.runTurn(goalTurn("goal-provider-failure", controller.signal, entries)).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    assert.equal(requests, 1, "a failed round must not be re-prompted by the goal loop");
    assert.ok(
      "error" in outcome && outcome.error instanceof ProviderTurnError && !outcome.error.retryable,
      "the turn fails with the provider error",
    );
    assert.match((outcome as { error: Error }).error.message, /credit balance is too low/);
    assert.equal(savedGoal("goal-provider-failure")?.status, "active", "the goal itself stays active for a later turn");
  } finally {
    globalThis.fetch = realFetch;
  }
});

function textStream(text: string, stopReason = "end_turn"): Response {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(
    event("message_start", {
      type: "message_start",
      message: {
        id: "m",
        type: "message",
        role: "assistant",
        content: [],
        model: "x",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }) +
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }) +
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
      event("content_block_stop", { type: "content_block_stop", index: 0 }) +
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { output_tokens: 3 },
      }) +
      event("message_stop", { type: "message_stop" }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test("a refused goal round preserves the goal and surfaces its typed refusal", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const entries: Array<{ type: string; payload: unknown }> = [];
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return textStream("", "refusal");
  }) as typeof globalThis.fetch;
  try {
    await assert.rejects(
      harness.turns.runTurn(goalTurn("goal-refusal", controller.signal, entries)),
      (error: unknown) => error instanceof ProviderTurnError && error.code === "refusal",
    );
    assert.equal(requests, 1);
    assert.equal(savedGoal("goal-refusal")?.status, "active");
  } finally {
    globalThis.fetch = realFetch;
  }
});
