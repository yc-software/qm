import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockHarness from "../src/harness/mock-harness.ts";
import { testConfig } from "./support/test-config.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

let exercise: (turn: HarnessTurnInput) => Promise<string>;
mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      harness.turns.runTurn = async (turn) => ({ reply: await exercise(turn) });
      return harness;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

const BASE = "https://qm.example";
const FOLLOW_UP = "And the follow-up is done.";

function steeredRun(firstAnswer: string) {
  return async (turn: HarnessTurnInput) => {
    turn.onTextBlockStart?.();
    turn.onDelta?.(firstAnswer);
    await turn.emit({ type: "tool_call", payload: { tool: "memory", callId: "c1" }, scopeLabel: turn.scopeLabel });
    return `${firstAnswer}\n\n${FOLLOW_UP}`;
  };
}

for (const firstAnswer of ["Here is the summary.", "Saved [the capture](/d/abc123)."]) {
  test(`a first answer already sent as the ack is not repeated in the reply: ${firstAnswer}`, async () => {
    const built = buildApp(testConfig({ workers: 1, publicWebUrl: BASE }));
    exercise = steeredRun(firstAnswer);
    built.runtime.start();
    try {
      const queued = await built.app.turn({
        surface: "slack",
        liveActor: true,
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `steered-ack-${firstAnswer}` },
        text: "Summarize it",
        async: true,
      });
      const run = await built.runs.waitFor(queued.runId!, 5000);
      const view = await built.app.getRun(queued.runId!);
      assert.equal(view?.firstBlockClosed, true);
      const reply = run?.result && "reply" in run.result ? run.result.reply : undefined;
      assert.equal(reply, FOLLOW_UP);
    } finally {
      await built.runtime.stop();
    }
  });
}

test("a spine DM sends a first answer with an app link once", async () => {
  const built = buildApp(testConfig({ workers: 1, publicWebUrl: BASE }));
  exercise = steeredRun("Saved [the capture](/d/abc123).");
  built.runtime.start();
  try {
    const queued = await built.app.turn({
      surface: "slack",
      liveActor: true,
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "steered-ack-spine" },
      text: "Summarize it",
      surfaceTools: true,
      addressed: true,
      deliveryTarget: "D1",
      async: true,
    });
    await built.runs.waitFor(queued.runId!, 5000);
    const texts = (await built.deliveries.pending("slack")).map((delivery) => delivery.text);
    assert.equal(texts.filter((text) => text.includes("the capture")).length, 1, JSON.stringify(texts));
    assert.ok(
      texts.some((text) => text.includes(FOLLOW_UP)),
      JSON.stringify(texts),
    );
  } finally {
    await built.runtime.stop();
  }
});
