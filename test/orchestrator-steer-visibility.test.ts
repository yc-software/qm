import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockHarness from "../src/harness/mock-harness.ts";
import { recordSteerIntake } from "../src/harness/harness-shared.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";
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

for (const mode of ["retry", "handoff"] as const) {
  test(`a ${mode} hides its synthetic trigger but not real steer intake in entries, tape, or activity`, async () => {
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
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        return {
          reply: "",
          runtimeHandoff: {
            choice: { harnessId: turn.runtime!.harnessId!, modelId: turn.runtime!.modelId! },
            lifetime: "task",
          },
        };
      }
      assert.match(turn.input, /previous attempt|Runtime handoff completed/);
      const trigger = await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
      await turn.tape!({
        kind: "message",
        harness: "pi",
        payload: { role: "user", content: turn.input },
        scopeLabel: turn.scopeLabel,
        entrySeq: trigger.seq,
        meta: { bareText: turn.input, entryCreatedAt: trigger.createdAt },
      });
      const stamp = await recordSteerIntake(turn, { text: "Change of plan", ts: "steer-visible" });
      await turn.tape!({
        kind: "message",
        harness: "pi",
        payload: { role: "user", content: "Change of plan" },
        scopeLabel: turn.scopeLabel,
        ...stamp,
      });
      const privateEntry = await turn.emit({
        type: "user",
        payload: { text: "private steer", steered: true, hidden: true },
        scopeLabel: turn.scopeLabel,
      });
      await turn.tape!({
        kind: "message",
        harness: "pi",
        payload: { role: "user", content: "private steer" },
        scopeLabel: turn.scopeLabel,
        entrySeq: privateEntry.seq,
        meta: { bareText: "private steer", entryCreatedAt: privateEntry.createdAt },
      });
    };
    try {
      const result = await built.app.turn(request);
      assert.equal(result.status, "ok");
      const session = await built.app.getSession(result.sessionId!);
      const users = session!.entries.filter((entry) => entry.type === "user");
      assert.equal((users[1]!.payload as { hidden?: boolean }).hidden, true);
      assert.equal((users[2]!.payload as { text?: string }).text, "Change of plan");
      assert.notEqual((users[2]!.payload as { hidden?: boolean }).hidden, true);
      assert.equal((users[3]!.payload as { hidden?: boolean }).hidden, true);
      const activity = (await built.app.getRun(runId!))!.activity ?? [];
      const liveSteer = activity.find(
        (entry) => entry.type === "user" && (entry.payload as { text?: string }).text === "Change of plan",
      );
      assert.ok(liveSteer);
      assert.notEqual((liveSteer.payload as { hidden?: boolean }).hidden, true);
      const tape = await built.sessions.getTape(result.sessionId!);
      for (const entry of users.slice(1)) {
        const row = tape.find((row) => row.kind === "message" && row.entrySeq === entry.seq);
        assert.ok(row);
        assert.equal(row.meta?.hidden === true, (entry.payload as { hidden?: boolean }).hidden === true);
      }
    } finally {
      exercise = undefined;
    }
  });
}
