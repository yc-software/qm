import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockAgent from "./support/mock-agent.ts";
import { recordSteerIntake } from "../src/agent/turn-support.ts";
import type { AgentTurnInput, AgentTurnResult } from "../src/agent/agent.ts";
import { eventually } from "./support/settle.ts";
import { retryDue } from "./support/absurd-clock.ts";
import type { TurnRequest, TurnResult } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

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
  test(`a ${mode} hides its synthetic trigger but not real steer intake in entries or activity`, async () => {
    const config = testConfig();
    const built = buildApp(config);
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "resume-steer-visibility" },
      text: "!work-then-boom",
      idempotencyKey: "resume-steer-visibility",
    };
    let pending: Promise<TurnResult> | undefined;
    if (mode === "retry") {
      pending = built.app.turn(request);
      await eventually(async () => (await built.runs.list({ limit: 5 }))[0]?.errorAttempts, {
        until: (errors) => errors === 1,
        label: "the first attempt failed and was handed back for a retry",
      });
    }
    let runId: string | undefined;
    exercise = async (turn) => {
      runId = turn.runId;
      if (mode === "handoff" && turn.input === request.text) {
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
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
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
      }
      await recordSteerIntake(turn, { text: "Change of plan", ts: "steer-visible" });
      await turn.emit({
        type: "user",
        payload: { text: "private steer", steered: true, hidden: true },
        scopeLabel: turn.scopeLabel,
      });
    };
    try {
      if (pending) assert.equal(await retryDue(config.databaseUrl!), 1);
      const result = await (pending ?? built.app.turn(request));
      assert.equal(result.status, "ok");
      const session = await built.app.getSession(result.sessionId!);
      const users = session!.entries.filter((entry) => entry.type === "user");
      const steerAt = mode === "retry" ? 1 : 2;
      if (mode !== "retry") assert.equal((users[1]!.payload as { hidden?: boolean }).hidden, true);
      assert.equal(users.length, steerAt + 2);
      assert.equal((users[steerAt]!.payload as { text?: string }).text, "Change of plan");
      assert.notEqual((users[steerAt]!.payload as { hidden?: boolean }).hidden, true);
      assert.equal((users[steerAt + 1]!.payload as { hidden?: boolean }).hidden, true);
      const activity = (await built.app.getRun(runId!))!.activity ?? [];
      const liveSteer = activity.find(
        (entry) => entry.type === "user" && (entry.payload as { text?: string }).text === "Change of plan",
      );
      assert.ok(liveSteer);
      assert.notEqual((liveSteer.payload as { hidden?: boolean }).hidden, true);
    } finally {
      exercise = undefined;
    }
  });
}
