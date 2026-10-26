import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockHarness from "./support/mock-harness.ts";
import { recordSteerIntake } from "../src/harness/harness-shared.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { isUserMessage } from "../src/sessions/items.ts";

let exercise: ((turn: HarnessTurnInput) => Promise<HarnessTurnResult | void>) | undefined;
mock.module("./support/mock-harness.ts", {
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
const { buildApp } = await import("./support/build-app.ts");

for (const mode of ["retry", "handoff"] as const) {
  test(`a ${mode} hides its synthetic trigger but not real steer intake in entries or activity`, async () => {
    const built = buildApp(testConfig());
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "resume-steer-visibility" },
      text: "!work-then-boom",
      idempotencyKey: "resume-steer-visibility",
    };
    if (mode === "retry") await assert.rejects(built.app.turn(request), /boom/);
    let runId: string | undefined;
    exercise = async (turn) => {
      runId = turn.runId;
      if (mode === "handoff" && turn.input === request.text) {
        await turn.emit({ kind: "UserMessage", text: turn.input });
        return {
          reply: "",
          runtimeHandoff: {
            choice: { harnessId: turn.runtime!.harnessId!, modelId: turn.runtime!.modelId! },
            lifetime: "task",
          },
        };
      }
      if (mode === "retry") assert.equal(turn.continueTurn, true);
      else {
        assert.match(turn.input, /Runtime switched/);
        await turn.emit({ kind: "UserMessage", text: turn.input });
      }
      await recordSteerIntake(turn, { text: "Change of plan", ts: "steer-visible" });
      await turn.emit({ kind: "SteeringMessage", text: "private steer", hidden: true });
    };
    try {
      const result = await built.app.turn(request);
      assert.equal(result.status, "ok");
      const session = await built.app.getSession(result.sessionId!);
      const users = session!.items.filter(isUserMessage);
      const steerAt = mode === "retry" ? 1 : 2;
      if (mode !== "retry") assert.equal(users[1]!.hidden, true);
      assert.equal(users.length, steerAt + 2);
      assert.equal(users[steerAt]!.text, "Change of plan");
      assert.notEqual(users[steerAt]!.hidden, true);
      assert.equal(users[steerAt + 1]!.hidden, true);
      const activity = (await built.app.getRun(runId!))!.activity ?? [];
      const liveSteer = activity
        .flatMap((entry) => ("item" in entry ? [entry.item] : []))
        .find((item) => isUserMessage(item) && item.text === "Change of plan");
      assert.ok(liveSteer);
      assert.notEqual(liveSteer.hidden, true);
    } finally {
      exercise = undefined;
    }
  });
}
