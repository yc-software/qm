import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as mockHarness from "../src/harness/mock-harness.ts";
import { tapeEntryMirrorRecord } from "../src/sessions/session-store.ts";
import { projectTapeEntries } from "../src/harness/tape-projection.ts";
import { testConfig } from "./support/test-config.ts";

mock.module("../src/harness/mock-harness.ts", {
  namedExports: {
    ...mockHarness,
    createMockHarness: () => {
      const harness = mockHarness.createMockHarness();
      harness.turns.runTurn = async (turn) => {
        if (turn.input !== "early") {
          const user = await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
          await turn.tape?.(tapeEntryMirrorRecord(user));
        }
        if (turn.input === "partial") {
          const assistant = await turn.emit({
            type: "assistant",
            payload: { text: "Partial answer" },
            scopeLabel: turn.scopeLabel,
          });
          await turn.tape?.(tapeEntryMirrorRecord(assistant));
        }
        return {
          reply: "",
          ...(turn.input !== "complete" ? { stopped: true as const, stoppedTapeComplete: true as const } : {}),
        };
      };
      return harness;
    },
  },
});
const { buildApp } = await import("../src/wiring.ts");

for (const text of ["early", "empty", "partial", "complete"]) {
  test(`turn termination is durable without manufacturing an assistant reply: ${text}`, async () => {
    const { app, sessions } = buildApp(testConfig());
    const before = Date.now();
    const result = await app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `stopped-${text}` },
      text,
    });
    const session = await app.getSession(result.sessionId!);
    assert.ok(session);
    assert.equal(session.entries.filter((entry) => entry.type === "user").length, 1);
    const stopped = session.entries.filter((entry) => (entry.payload as { kind?: string })?.kind === "turn_stopped");
    assert.equal(stopped.length, text === "complete" ? 0 : 1);
    assert.equal(session.entries.filter((entry) => entry.type === "assistant").length, text === "partial" ? 1 : 0);
    if (text !== "complete") {
      const payload = stopped[0]!.payload as { workStartedAt: number; workFinishedAt: number };
      assert.ok(payload.workStartedAt >= before);
      assert.ok(payload.workFinishedAt >= payload.workStartedAt);
      const tape = await sessions.getTape(result.sessionId!);
      assert.equal(await sessions.tapeCoverage(result.sessionId!), await sessions.latestEntrySeq(result.sessionId!));
      assert.ok(projectTapeEntries(result.sessionId!, tape));
      assert.ok(JSON.stringify(tape).includes('"turn_stopped"'));
    }
  });
}
