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
    const blob = await built.blobTransfer.put(Buffer.from("CURRENT-DOCUMENT"));
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "resume-steer-visibility" },
      text: "!work-then-boom",
      idempotencyKey: "resume-steer-visibility",
      attachments: [{ name: "current.txt", mimetype: "text/plain", sourceId: "current-upload", ...blob }],
    };
    if (mode === "retry") await assert.rejects(built.app.turn(request), /boom/);
    let runId: string | undefined;
    exercise = async (turn) => {
      runId = turn.runId;
      assert.deepEqual(
        turn.documents?.map((doc) => doc.name),
        ["current.txt"],
      );
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

for (const mode of ["retry", "approval"] as const) {
  test(`document-bearing steers survive ${mode} after a text-only steer`, async () => {
    const built = buildApp(testConfig());
    const blob = await built.blobTransfer.put(Buffer.from("STEER-DOCUMENT"));
    const request: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `steer-documents-${mode}` },
      text: "Read the document I send next",
      ...(mode === "retry" ? { idempotencyKey: "steer-documents-retry" } : {}),
    };
    let calls = 0;
    exercise = async (turn) => {
      if (calls++ === 0) {
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        const steer = await turn.prepareSteer!("Here it is", {
          ...request,
          attachments: [{ name: "steered.txt", mimetype: "text/plain", ...blob }],
        });
        await recordSteerIntake(turn, steer);
        await recordSteerIntake(turn, { text: "Be concise" });
        if (mode === "retry") throw new Error("interrupted after steer");
      } else {
        assert.deepEqual(
          turn.documents?.map((doc) => doc.name),
          calls === 3 ? ["steered.txt", "second.txt"] : ["steered.txt"],
        );
        assert.equal(Buffer.from(turn.documents![0]!.dataBase64, "base64").toString(), "STEER-DOCUMENT");
        if (mode === "retry" || calls === 3) return { reply: "Read it" };
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        const second = await turn.prepareSteer!("Another document", {
          ...request,
          attachments: [{ name: "second.txt", mimetype: "text/plain", ...blob }],
        });
        await recordSteerIntake(turn, second);
        await recordSteerIntake(turn, { text: "Be concise again" });
      }
      return {
        reply: "",
        pausedOnApproval: true,
        pendingApprovals: [{ command: `printf approved-${calls}`, reason: "test approval" }],
      };
    };
    try {
      if (mode === "retry") {
        await assert.rejects(built.app.turn(request), /interrupted after steer/);
        assert.equal((await built.app.turn(request)).status, "ok");
      } else {
        let result = await built.app.turn(request);
        for (let i = 0; i < 2; i++) {
          assert.equal(result.status, "pending_approval");
          const requestId = result.pendingApprovals![0]!.requestId;
          assert.equal((await built.app.getApproval(requestId))!.turnUserSeq, 0);
          result = await built.app.turn({ ...request, approval: { requestId, approved: true } });
        }
        assert.equal(result.status, "ok");
      }
    } finally {
      exercise = undefined;
    }
  });
}

test("mid-turn compaction does not reattach documents excluded from retained history", async () => {
  const built = buildApp(testConfig({ maxContextTokens: 1000 }));
  const blob = await built.blobTransfer.put(Buffer.from("COMPACTED-DOCUMENT"));
  let calls = 0;
  let artifactId: string | undefined;
  exercise = async (turn) => {
    calls++;
    if (calls === 1) {
      assert.equal(turn.documents?.length, 1);
      artifactId = turn.documents![0]!.artifactId;
      await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
      await turn.emit({
        type: "assistant",
        payload: { text: "Newer context to retain. ".repeat(1000) },
        scopeLabel: turn.scopeLabel,
      });
      return { reply: "", runtimeHandoff: { context: "recent" } };
    }
    assert.equal(calls, 2);
    assert.ok(turn.history.some((entry) => (entry.payload as { mode?: string }).mode === "recent"));
    assert.ok(artifactId);
    assert.ok(!JSON.stringify(turn.history).includes(artifactId));
    assert.deepEqual(turn.documents ?? [], []);
    assert.deepEqual(turn.historyDocuments ?? [], []);
    return { reply: "Done" };
  };
  try {
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "compact-during-document-turn" },
      text: "Use this document and then reduce context",
      attachments: [{ name: "compacted.txt", mimetype: "text/plain", ...blob }],
    });
    assert.equal(result.status, "ok");
    assert.equal(calls, 2);
  } finally {
    exercise = undefined;
  }
});
