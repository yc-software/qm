import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockHarness from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";
import { isResumeNote } from "../src/core/turn-resume.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

let exercise: ((turn: HarnessTurnInput) => Promise<HarnessTurnResult | void>) | undefined;
mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      const run = harness.turns.runTurn;
      harness.turns.runTurn = async (turn) => {
        if (!exercise) return run(turn);
        return (await exercise(turn)) ?? { reply: "Done" };
      };
      return harness;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

for (const kind of ["context", "runtime"] as const) {
  test(`a ${kind} handoff resumes without telling the agent it was interrupted`, async () => {
    const built = buildApp(testConfig());
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `handoff-note-${kind}` },
      text: "research the next batch",
      idempotencyKey: `handoff-note-${kind}`,
    };
    const inputs: string[] = [];
    exercise = async (turn) => {
      inputs.push(turn.input);
      if (inputs.length > 1) return { reply: "Batch done" };
      await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
      return {
        reply: "",
        runtimeHandoff:
          kind === "context"
            ? { context: "recent" }
            : { choice: { harnessId: turn.runtime!.harnessId!, modelId: turn.runtime!.modelId! }, lifetime: "task" },
      };
    };
    try {
      const result = await built.app.turn(request);
      assert.equal(result.status, "ok");
      assert.equal(inputs.length, 2);
      const resumed = inputs[1]!;
      assert.ok(isResumeNote(resumed), "the continuation stays a system note so replay and resume skip it");
      assert.doesNotMatch(resumed, /interrupted mid-turn|previous attempt/);
      assert.match(resumed, /Nothing was interrupted/);
      assert.match(resumed, kind === "context" ? /context tool/ : /Runtime handoff completed/);
    } finally {
      exercise = undefined;
    }
  });
}
