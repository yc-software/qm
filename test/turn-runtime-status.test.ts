import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockHarness from "./support/mock-harness.ts";
import { testConfig } from "./support/test-config.ts";

let started!: () => void;
let release!: () => void;
let handoffTo: string | undefined;
mock.module("./support/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      harness.turns.runTurn = async () => {
        if (handoffTo) {
          const modelId = handoffTo;
          handoffTo = undefined;
          return {
            reply: "",
            runtimeHandoff: { choice: { harnessId: "pi", modelId }, lifetime: "task" as const },
          };
        }
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { reply: "Done" };
      };
      return harness;
    },
  },
});
const { buildApp } = await import("./support/build-app.ts");

test("a run reports the runtime its turn runs on while working and after it finishes", async () => {
  const built = buildApp(testConfig({ workers: 1 }));
  built.runtime.start();
  try {
    for (const model of [undefined, "claude-haiku-5-5"]) {
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const queued = await built.app.turn({
        surface: "web",
        liveActor: true,
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `runtime-${model ?? "default"}` },
        text: "hello",
        async: true,
        ...(model ? { model } : {}),
      });
      await ready;
      const live = (await built.app.getRun(queued.runId!))?.runtime;
      assert.ok(live?.modelId);
      if (model) assert.equal(live.modelId, model);
      assert.equal(live.change, undefined);
      release();
      await built.runs.waitFor(queued.runId!, 5000);
      assert.deepEqual((await built.runs.get(queued.runId!))?.result?.runtime, live);
    }
  } finally {
    release?.();
    await built.runtime.stop();
  }
});

test("a runtime the agent switches to mid-turn is reported as its switch", async () => {
  const built = buildApp(testConfig({ workers: 1 }));
  built.runtime.start();
  try {
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    handoffTo = "claude-haiku-5-5";
    const queued = await built.app.turn({
      surface: "web",
      liveActor: true,
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "runtime-switch" },
      text: "switch me to haiku",
      async: true,
    });
    await ready;
    const live = (await built.app.getRun(queued.runId!))?.runtime;
    assert.equal(live?.modelId, "claude-haiku-5-5");
    assert.deepEqual(live.change, { agent: "task" });
    release();
    await built.runs.waitFor(queued.runId!, 5000);
    assert.deepEqual((await built.runs.get(queued.runId!))?.result?.runtime, live);
  } finally {
    release?.();
    await built.runtime.stop();
  }
});
