import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockAgent from "./support/mock-agent.ts";
import { testConfig } from "./support/test-config.ts";

let handoffTo: string | undefined;
let opened: Promise<string | undefined> | undefined;
mock.module("./support/mock-agent.ts", {
  namedExports: {
    ...mockAgent,
    createMockAgent: () => {
      const agent = mockAgent.createMockAgent();
      agent.runTurn = async (turn) => {
        if (handoffTo) {
          const modelId = handoffTo;
          handoffTo = undefined;
          return { reply: "", runtimeHandoff: { choice: { modelId, effortLevel: "high" }, lifetime: "task" as const } };
        }
        const out = await turn.tools.sessionSyscalls?.open({ task: "draft one article" });
        opened = Promise.resolve(out?.ok ? out.sessionId : out?.message);
        return { reply: "Done" };
      };
      return agent;
    },
  },
});
const { buildApp } = await import("./support/build-app.ts");

test("a subagent opened after a task runtime switch inherits the switched runtime", async () => {
  const built = buildApp(testConfig({ workers: 1 }));
  built.runtime.start();
  try {
    handoffTo = "claude-haiku-5-5";
    const queued = await built.app.turn({
      surface: "web",
      origin: { kind: "human" },
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "runtime-inherit" },
      text: "switch to haiku, then delegate",
      async: true,
    });
    await built.runs.waitFor(queued.runId!, 5000);
    const childId = await opened;
    assert.ok(childId);
    const meta = (await built.sessions.get(childId))?.spawnMeta;
    assert.equal(meta?.model, "claude-haiku-5-5", childId);
    assert.equal(meta?.thinkingLevel, "high");
  } finally {
    await built.runtime.stop();
  }
});
