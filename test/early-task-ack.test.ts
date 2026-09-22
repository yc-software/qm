import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockHarness from "../src/harness/mock-harness.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

let exercise: (turn: HarnessTurnInput) => Promise<void>;
mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      harness.turns.runTurn = async (turn) => {
        await exercise(turn);
        return { reply: "Done" };
      };
      return harness;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

for (const scenario of [
  { name: "human DM", enabled: true },
  { name: "channel", enabled: false, conversation: { kind: "channel", channelRef: "C1" } },
  { name: "group DM", enabled: false, conversation: { kind: "group", channelRef: "G1", isMpim: true } },
  { name: "automation", enabled: false, triggered: true },
  { name: "bot", enabled: false, botActor: true },
] as const) {
  test(`queued ${scenario.name} closes acknowledgement at tool start=${scenario.enabled}`, async () => {
    const built = buildApp(testConfig({ workers: 1 }));
    let release!: () => void;
    let started!: () => void;
    const block = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      started = r;
    });
    exercise = async (turn) => {
      turn.onTextBlockStart?.();
      turn.onDelta?.("Building the website now.");
      turn.onToolCallStart?.("execute");
      started();
      await block;
    };
    built.runtime.start();
    try {
      const request: TurnRequest = {
        surface: "slack",
        liveActor: true,
        actor: { externalId: "U1" },
        ...scenario,
        conversation: {
          kind: "dm",
          threadRef: `early-${scenario.name}`,
          ...("conversation" in scenario ? scenario.conversation : {}),
        },
        text: "Build a website",
        async: true,
      };
      const queued = await built.app.turn(request);
      await ready;
      const run = await built.app.getRun(queued.runId!);
      if (scenario.enabled) assert.equal(run?.firstBlock, "Building the website now.");
      assert.equal(run?.firstBlockClosed === true, scenario.enabled);
      release();
      await built.runs.waitFor(queued.runId!, 5000);
    } finally {
      release();
      await built.runtime.stop();
    }
  });
}

for (const action of ["read", "react", "post"] as const) {
  test(`surface ${action} defers early acknowledgement until the parsed action`, async () => {
    const built = buildApp(testConfig({ workers: 1 }));
    let release!: () => void;
    let started!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    exercise = async (turn) => {
      turn.onTextBlockStart?.();
      turn.onDelta?.("Building the website now.");
      turn.onToolCallStart?.("slack");
      assert.equal((await built.deliveries.pending("slack")).length, 0);
      await turn.emit({ type: "tool_call", payload: { tool: "slack", action }, scopeLabel: turn.scopeLabel });
      started();
      await block;
    };
    built.runtime.start();
    try {
      const queued = await built.app.turn({
        surface: "slack",
        liveActor: true,
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `surface-${action}` },
        text: "Build a website",
        surfaceTools: true,
        addressed: true,
        deliveryTarget: "D1",
        async: true,
      });
      await ready;
      const deliveries = await built.deliveries.pending("slack");
      assert.deepEqual(
        deliveries.map((delivery) => delivery.text),
        action === "post" ? [] : ["Building the website now."],
      );
      release();
      await built.runs.waitFor(queued.runId!, 5000);
    } finally {
      release();
      await built.runtime.stop();
    }
  });
}
