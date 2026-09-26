import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoalRecord, latestGoalRecord, rehydrateOpenGoal } from "../src/harness/goal.ts";
import type { Harness, HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";
import { createHarnessRouter } from "../src/harness/harness-router.ts";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import type { ScopeId, SessionEntry } from "../src/types.ts";

import { createMemoryRunSignalStore, startSignalPoll } from "../src/runs/run-signal-store.ts";

const scope = "personal:goal@example.com" as ScopeId;

type Round = (turn: HarnessTurnInput, round: number) => Promise<HarnessTurnResult>;

function fakeAdapter(rounds: Round, selfEnforcing = false): { harness: Harness; calls: HarnessTurnInput[] } {
  const calls: HarnessTurnInput[] = [];
  const mock = createMockHarness();
  const harness: Harness = {
    ...mock,
    profile: { ...mock.profile, capabilities: new Set(selfEnforcing ? ["goal-enforcement"] : []) },
    turns: {
      async runTurn(turn) {
        calls.push(turn);
        await turn.emit({ type: "user", payload: { text: turn.input }, scopeLabel: turn.scopeLabel });
        return rounds(turn, calls.length - 1);
      },
    },
  };
  return { harness, calls };
}

function stubTurn(emitted: SessionEntry[], extra: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  let seq = 0;
  return {
    session: { id: "s1" },
    input: "build the thing",
    systemPrompt: "",
    history: [],
    tools: {},
    scopeLabel: scope,
    orgScopeId: "org:acme" as ScopeId,
    emit: async (entry: { type: SessionEntry["type"]; payload: unknown; scopeLabel: ScopeId }) => {
      const stored = { ...entry, sessionId: "s1", seq: seq++, parentSeq: null, createdAt: 1000 + seq } as SessionEntry;
      emitted.push(stored);
      return stored;
    },
    ...extra,
  } as unknown as HarnessTurnInput;
}

function router(harness: Harness): Harness {
  return createHarnessRouter(new Map([["codex", harness]]), createMockHarness(), async () => ({
    harnessId: "codex",
    modelId: "gpt-5.6-codex",
  }));
}

async function emitGoalCreate(turn: HarnessTurnInput, objective: string) {
  const goal = createGoalRecord({ objective, source: "tool" });
  await turn.emit({ type: "tool_call", payload: { tool: "goal", action: "create", callId: "c1" }, scopeLabel: scope });
  await turn.emit({
    type: "tool_result",
    payload: { tool: "goal", action: "create", goal, callId: "c1" },
    scopeLabel: scope,
  });
  return goal;
}

test("an active goal left open by a non-enforcing harness is continued until the agent completes it", async () => {
  const emitted: SessionEntry[] = [];
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) {
      await emitGoalCreate(turn, "make all tests pass");
      return { reply: "starting" };
    }
    assert.match(turn.input, /^\[goal\] The active goal is not marked complete/);
    assert.match(turn.input, /make all tests pass/);
    assert.equal(turn.goal?.status, "active");
    if (round === 1) {
      await turn.emit({ type: "tool_call", payload: { tool: "execute", callId: "c2" }, scopeLabel: scope });
      return { reply: "working" };
    }
    turn.goal!.status = "complete";
    await turn.emit({
      type: "tool_result",
      payload: { tool: "goal", action: "update", goal: { ...turn.goal }, callId: "c3" },
      scopeLabel: scope,
    });
    return { reply: "done" };
  });

  const result = await router(harness).turns.runTurn(stubTurn(emitted, { turnWallClockMs: 600_000 }));

  assert.equal(calls.length, 3);
  assert.equal(result.reply, "done");
  assert.equal(calls[1]!.history.length, 3, "the continuation replays this turn's entries");
  assert.ok(calls[1]!.turnWallClockMs! <= 600_000);
  assert.equal(calls[2]!.goal, calls[1]!.goal, "rounds share one goal record");
  const last = emitted.at(-1)!;
  assert.equal(last.type, "system");
  assert.deepEqual(
    (last.payload as { kind: string; goal: { status: string } }).goal.status,
    "complete",
    "the final goal snapshot is persisted for later turns",
  );
});

test("a harness that enforces goals itself is left alone", async () => {
  const emitted: SessionEntry[] = [];
  const { harness, calls } = fakeAdapter(async (turn) => {
    await emitGoalCreate(turn, "self-enforced");
    return { reply: "pi handles it" };
  }, true);
  const result = await router(harness).turns.runTurn(stubTurn(emitted));
  assert.equal(calls.length, 1);
  assert.equal(result.reply, "pi handles it");
  assert.ok(!emitted.some((entry) => entry.type === "system"));
});

test("a stopped turn pauses the goal instead of continuing it", async () => {
  const emitted: SessionEntry[] = [];
  const { harness, calls } = fakeAdapter(async (turn) => {
    await emitGoalCreate(turn, "interrupted work");
    return { reply: "", stopped: true };
  });
  await router(harness).turns.runTurn(stubTurn(emitted));
  assert.equal(calls.length, 1);
  const snapshot = emitted.at(-1)!.payload as { kind: string; goal: { status: string } };
  assert.equal(snapshot.kind, "goal");
  assert.equal(snapshot.goal.status, "paused");
});

test("turns without a goal pass through untouched", async () => {
  const emitted: SessionEntry[] = [];
  const { harness, calls } = fakeAdapter(async () => ({ reply: "plain" }));
  const result = await router(harness).turns.runTurn(stubTurn(emitted));
  assert.equal(calls.length, 1);
  assert.equal(result.reply, "plain");
  assert.deepEqual(
    emitted.map((entry) => entry.type),
    ["user"],
  );
});

test("an open goal from an earlier turn is picked up from history", async () => {
  const emitted: SessionEntry[] = [];
  const prior = createGoalRecord({ objective: "carried over", source: "tool" });
  const history = [
    { type: "system", payload: { kind: "goal", goal: prior }, sessionId: "s1", seq: 0, parentSeq: null, createdAt: 1 },
  ] as SessionEntry[];
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) return { reply: "forgot about the goal" };
    turn.goal!.status = "complete";
    return { reply: "now done" };
  });
  const result = await router(harness).turns.runTurn(stubTurn(emitted, { history }));
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.input, /carried over/);
  assert.equal(result.reply, "now done");
});

test("rounds without progress are waived after the stall limit and the waiver reaches the reply", async () => {
  const emitted: SessionEntry[] = [];
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) await emitGoalCreate(turn, "spin forever");
    return { reply: `round ${round}` };
  });
  const result = await router(harness).turns.runTurn(stubTurn(emitted));
  assert.equal(calls.length, 5);
  assert.match(result.reply, /\[goal waived: no progress after 5 continuation rounds — still active\]/);
  const kinds = emitted.slice(-2).map((entry) => entry.type);
  assert.deepEqual(kinds, ["system", "assistant"]);
});

for (const harnessId of ["codex", "claude", "opencode"] as const) {
  test(`${harnessId} preserves an active goal on infrastructure cancellation and resumes after reload`, async () => {
    const emitted: SessionEntry[] = [];
    const cancel = new AbortController();
    const stopped = fakeAdapter(async (turn) => {
      await emitGoalCreate(turn, "survive shutdown");
      cancel.abort();
      return { reply: "", stopped: true };
    });
    const routed = (harness: Harness) =>
      createHarnessRouter(new Map([[harnessId, harness]]), createMockHarness(), async () => ({
        harnessId,
        modelId: "unused",
      }));
    await routed(stopped.harness).turns.runTurn(stubTurn(emitted, { cancel: cancel.signal }));
    assert.equal((emitted.at(-1)!.payload as { goal: { status: string } }).goal.status, "active");
    const resumed = fakeAdapter(async (turn, round) => {
      if (round === 0) return { reply: "continue" };
      assert.match(turn.input, /survive shutdown/);
      turn.goal!.status = "complete";
      return { reply: "verified" };
    });
    const result = await routed(resumed.harness).turns.runTurn(stubTurn([], { history: emitted }));
    assert.equal(resumed.calls.length, 2);
    assert.equal(result.reply, "verified");
  });
}

for (const harnessId of ["codex", "claude", "opencode"] as const) {
  test(`${harnessId} persists user Stop when shutdown races with the real run signal`, async () => {
    const signals = createMemoryRunSignalStore();
    const cancel = new AbortController();
    const emitted: SessionEntry[] = [];
    const { harness, calls } = fakeAdapter(async (turn) => {
      await emitGoalCreate(turn, "stop despite shutdown");
      const observed = Promise.withResolvers<void>();
      let stoppedByUser: true | undefined;
      const stop = startSignalPoll(signals, "run", {
        onSteer: async () => {},
        onAbort: async () => {
          stoppedByUser = true;
          observed.resolve();
        },
      });
      await signals.send("run", { kind: "abort" });
      await observed.promise;
      cancel.abort();
      await stop();
      return { reply: "", stopped: true, stoppedByUser };
    });
    const routed = createHarnessRouter(new Map([[harnessId, harness]]), createMockHarness(), async () => ({
      harnessId,
      modelId: "test",
    }));
    await routed.turns.runTurn(stubTurn(emitted, { cancel: cancel.signal }));
    assert.equal(calls.length, 1);
    assert.equal(latestGoalRecord(emitted)?.status, "paused");
    assert.equal(rehydrateOpenGoal(emitted)?.status, "paused");
  });
}
