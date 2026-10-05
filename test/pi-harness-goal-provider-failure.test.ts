import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoalRecord, latestGoalRecord } from "../src/harness/goal.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { ProviderTurnError } from "../src/core/turn-error.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewEntry } from "../src/sessions/session-store.ts";
import type { SessionEntry } from "../src/types.ts";

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
    history: [
      {
        type: "tool_result",
        payload: { tool: "goal", action: "create", goal },
        seq: 0,
        sessionId,
        parentSeq: null,
        createdAt: 1,
        scopeLabel: "personal:tester" as HarnessTurnInput["scopeLabel"],
      },
    ],
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
    assert.equal(latestGoalRecord(entries)?.status, "active", "the goal itself stays active for a later turn");
  } finally {
    globalThis.fetch = realFetch;
  }
});

function textStream(text: string): Response {
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
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      }) +
      event("message_stop", { type: "message_stop" }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test("a refused goal round falls back to another model and the goal keeps going", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const entries: Array<{ type: string; payload: unknown }> = [];
  const realFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const model = (JSON.parse(String(init?.body ?? "{}")) as { model: string }).model;
    models.push(model);
    if (models.length >= 5) controller.abort();
    if (models.length >= 2 && model === models[0])
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "API integrators: you can reduce refusals for your users by configuring a fallback model",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    return textStream(`reply ${models.length}`);
  }) as typeof globalThis.fetch;
  try {
    await harness.turns.runTurn(goalTurn("goal-refusal-fallback", controller.signal, entries)).catch(() => undefined);
    const [primary, refused, fallback, continued] = models;
    assert.equal(refused, primary, "the second round goes to the primary model and is refused");
    assert.notEqual(fallback, primary, "the refused round is answered by a fallback model");
    assert.equal(continued, fallback, "the goal keeps going on the fallback model instead of stopping");
    assert.equal(latestGoalRecord(entries)?.status, "active");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a goal never falls back to a model that already refused in the same turn", async () => {
  const harness = createPiHarness({ apiKey: "sk-test" });
  const controller = new AbortController();
  const entries: Array<{ type: string; payload: unknown }> = [];
  const realFetch = globalThis.fetch;
  const models: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { model: string; messages: unknown[] };
    models.push(request.model);
    if (models.length >= 8) controller.abort();
    const latest = JSON.stringify(request.messages.at(-1));
    if (models.length === 1 || latest.includes("could not answer this request"))
      return textStream(`reply ${models.length}`);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "API integrators: you can reduce refusals for your users by configuring a fallback model",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  try {
    const outcome = await harness.turns.runTurn(goalTurn("goal-refusal-alternation", controller.signal, entries)).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const [primary, refused, fallback, refusedAgain] = models;
    assert.deepEqual([refused, refusedAgain], [primary, fallback]);
    assert.equal(models.length, 4, "the turn ends instead of bouncing back to the model that already refused");
    assert.ok("error" in outcome && outcome.error instanceof ProviderTurnError && !outcome.error.retryable);
    assert.equal(latestGoalRecord(entries)?.status, "active");
  } finally {
    globalThis.fetch = realFetch;
  }
});
