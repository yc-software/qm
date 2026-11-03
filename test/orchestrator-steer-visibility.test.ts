import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockAgent from "./support/mock-agent.ts";
import { recordSteerIntake } from "../src/agent/turn-support.ts";
import type { AgentTurnInput, AgentTurnResult } from "../src/agent/agent.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { isHidden, isUserItem } from "../src/sessions/items.ts";
import { firstAttemptFailed } from "./support/settle.ts";

let exercise: ((turn: AgentTurnInput) => Promise<AgentTurnResult | void>) | undefined;
mock.module("./support/mock-agent.ts", {
  namedExports: {
    ...mockAgent,
    createMockAgent: () => {
      const agent = mockAgent.createMockAgent();
      const run = agent.runTurn;
      agent.runTurn = async (turn) => {
        if (!exercise) return run(turn);
        return (await exercise(turn)) ?? { reply: "Done" };
      };
      return agent;
    },
  },
});
const { buildApp } = await import("./support/build-app.ts");

for (const mode of ["retry", "handoff"] as const) {
  test(`a ${mode} hides its synthetic trigger but not real steer intake in entries or activity`, async (t) => {
    const built = buildApp(testConfig());
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "resume-steer-visibility" },
      text: "!work-then-boom",
      idempotencyKey: "resume-steer-visibility",
    };
    if (mode === "retry") await firstAttemptFailed(built, request);
    let runId: string | undefined;
    exercise = async (turn) => {
      runId = turn.runId;
      if (mode === "handoff" && turn.input === request.text) {
        await turn.emit({ kind: "UserMessage", text: turn.input });
        return {
          reply: "",
          runtimeHandoff: {
            choice: { modelId: turn.runtime!.modelId! },
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
    };
    try {
      if (mode === "retry") {
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
        t.mock.timers.tick(61_000);
      }
      const result = await built.app.turn(request);
      assert.equal(result.status, "ok");
      const session = await built.app.getSession(result.sessionId!);
      const users = session!.items.filter(isUserItem);
      const steerAt = mode === "retry" ? 1 : 2;
      if (mode !== "retry") assert.equal(isHidden(users[1]!), true);
      assert.equal(users.length, steerAt + 1);
      assert.equal(users[steerAt]!.text, "Change of plan");
      assert.notEqual(isHidden(users[steerAt]!), true);
      const activity = (await built.app.getRun(runId!))!.activity ?? [];
      const liveSteer = activity.flatMap((entry) =>
        "item" in entry && isUserItem(entry.item) && entry.item.text === "Change of plan" ? [entry.item] : [],
      )[0];
      assert.ok(liveSteer);
      assert.notEqual(isHidden(liveSteer), true);
    } finally {
      exercise = undefined;
    }
  });
}
