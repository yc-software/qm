import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mockHarness from "../src/harness/mock-harness.ts";
import type { HarnessTurnResult } from "../src/harness/harness.ts";
import { testConfig } from "./support/test-config.ts";

let result: HarnessTurnResult = { reply: "Done" };
mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      harness.turns.runTurn = async (turn) => {
        await turn.emit({ type: "assistant", payload: { text: result.reply }, scopeLabel: turn.scopeLabel });
        return result;
      };
      return harness;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

for (const reported of [false, true]) {
  test(`a turn whose harness ${reported ? "reports" : "does not report"} cache usage records ${reported ? "those numbers" : "no cache numbers"}`, async () => {
    result = {
      reply: "Done",
      modelCalls: 1,
      ...(reported ? { cacheUsage: { cacheRead: 30, cacheWrite: 5, uncachedInput: 7 } } : {}),
    };
    const { app, metrics } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cache-usage-")) }));
    const res = await app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:cache-${reported}` },
      text: "hi",
    });
    assert.equal(res.status, "ok");
    const [sample] = (await metrics.list()).filter((s) => s.status !== "capture");
    assert.ok(sample);
    assert.deepEqual(
      { cacheRead: sample.cacheRead, cacheWrite: sample.cacheWrite, uncachedInput: sample.uncachedInput },
      reported
        ? { cacheRead: 30, cacheWrite: 5, uncachedInput: 7 }
        : { cacheRead: undefined, cacheWrite: undefined, uncachedInput: undefined },
    );
  });
}
