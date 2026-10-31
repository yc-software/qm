import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockAgent from "./support/mock-agent.ts";
import { testConfig } from "./support/test-config.ts";

mock.module("./support/mock-agent.ts", {
  namedExports: {
    ...mockAgent,
    createMockAgent: () => {
      const agent = mockAgent.createMockAgent();
      agent.runTurn = async () => ({ reply: "Done" });
      return agent;
    },
  },
});
const { buildApp } = await import("./support/build-app.ts");

for (const { surface, replying } of [
  { surface: "discord", replying: true },
  { surface: "slack", replying: true },
  { surface: "web", replying: false },
] as const) {
  test(`a ${surface} run persists the durable replying state once its reply begins: ${replying}`, async () => {
    const built = buildApp(testConfig({ workers: 1 }));
    built.runtime.start();
    try {
      const queued = await built.app.turn({
        surface,
        liveActor: true,
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `replying-${surface}` },
        text: "hello",
        async: true,
      });
      await built.runs.waitFor(queued.runId!, 5000);
      const run = await built.runs.get(queued.runId!);
      assert.equal(run?.deliveryState?.replying === true, replying);
    } finally {
      await built.runtime.stop();
    }
  });
}
