import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoalRecord, latestGoalRecord } from "../src/harness/goal.ts";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
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
      "error" in outcome && outcome.error instanceof NonRetryableTurnError,
      "the turn fails with the provider error",
    );
    assert.match((outcome as { error: Error }).error.message, /credit balance is too low/);
    assert.equal(latestGoalRecord(entries)?.status, "active", "the goal itself stays active for a later turn");
  } finally {
    globalThis.fetch = realFetch;
  }
});
