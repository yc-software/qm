import assert from "node:assert/strict";
import { test } from "node:test";
import { startQm } from "../src/start.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { testConfig } from "./support/test-config.ts";

test("a turn submitted to QM booted by startQm completes", async (t) => {
  const config = testConfig({ allowUnauthenticatedCore: true, runWaitMs: 10_000 });
  const qm = await startQm(config, { agent: createMockAgent() });
  t.after(() => qm.stop());
  const conversation = { kind: "dm" as const, threadRef: "start-qm" };
  const result = await qm.built.app.turn({ surface: "test", actor: { externalId: "U1" }, conversation, text: "hello" });
  assert.equal(result.status, "ok", result.reason);
});
