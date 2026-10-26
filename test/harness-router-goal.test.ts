import assert from "node:assert/strict";
import { test } from "node:test";
import { createGoalRecord, openGoal, type GoalRecord } from "../src/harness/goal.ts";
import type { Harness, HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";
import { createHarnessRouter } from "../src/harness/harness-router.ts";
import { createMockHarness } from "./support/mock-harness.ts";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { harnessToolContext } from "../src/harness/harness-shared.ts";
import type { ScopeId } from "../src/types.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";

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
        await turn.emit({ kind: "UserMessage", text: turn.input });
        return rounds(turn, calls.length - 1);
      },
    },
  };
  return { harness, calls };
}

const CONVERSATION_KINDS = new Set<Item["kind"]>(["UserMessage", "AgentMessage", "ToolCall", "ToolResult"]);
const rows = new WeakMap<Item[], GoalRecord[]>();
const saves = (emitted: Item[]) => rows.get(emitted) ?? [];
const savedGoal = (emitted: Item[]) => saves(emitted).at(-1) ?? null;

function stubTurn(emitted: Item[], extra: Partial<HarnessTurnInput> = {}): HarnessTurnInput {
  let seq = 0;
  rows.set(emitted, []);
  return {
    session: { id: "s1" },
    input: "build the thing",
    systemPrompt: "",
    history: [],
    tools: {},
    scopeLabel: scope,
    orgScopeId: "org:acme" as ScopeId,
    emit: async (item: NewItem) => {
      const stored = storedItem(item, { sessionId: "s1", seq: seq++, createdAt: 1000 + seq });
      emitted.push(stored);
      return stored;
    },
    saveGoal: async (goal: GoalRecord) => {
      rows.get(emitted)!.push(structuredClone(goal));
    },
    ...extra,
  } as unknown as HarnessTurnInput;
}

function router(harness: Harness): Harness {
  return createHarnessRouter(new Map([["claude", harness]]), createMockHarness(), async () => ({
    harnessId: "claude",
    modelId: "claude-opus-5-5",
  }));
}

async function emitGoalCreate(turn: HarnessTurnInput, objective: string) {
  const goal = createGoalRecord({ objective });
  await turn.emit({ kind: "ToolCall", tool: "goal", callId: "c1", body: { action: "create" } });
  await turn.emit({ kind: "ToolResult", tool: "goal", callId: "c1", body: { action: "create", goal } });
  await turn.saveGoal?.(goal);
  return goal;
}

test("an active goal left open by a non-enforcing harness is continued until the agent completes it", async () => {
  const emitted: Item[] = [];
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) {
      await emitGoalCreate(turn, "make all tests pass");
      return { reply: "starting" };
    }
    assert.match(turn.input, /^\[goal\] The active goal is not marked complete/);
    assert.match(turn.input, /make all tests pass/);
    assert.equal(turn.goal?.status, "active");
    if (round === 1) {
      await turn.emit({ kind: "ToolCall", tool: "execute", callId: "c2" });
      return { reply: "working" };
    }
    turn.goal!.status = "complete";
    return { reply: "done" };
  });

  const result = await router(harness).turns.runTurn(stubTurn(emitted, { turnWallClockMs: 600_000 }));

  assert.equal(calls.length, 3);
  assert.equal(result.reply, "done");
  assert.equal(calls[1]!.history.length, 3, "the continuation replays this turn's entries");
  assert.ok(calls[1]!.turnWallClockMs! <= 600_000);
  assert.equal(calls[2]!.goal, calls[1]!.goal, "rounds share one goal record");
  assert.equal(savedGoal(emitted)?.status, "complete", "the final goal is saved on the session for later turns");
  assert.ok(
    emitted.every((item) => CONVERSATION_KINDS.has(item.kind)),
    "no goal snapshot entries",
  );
});

test("a harness that enforces goals itself is left alone", async () => {
  const emitted: Item[] = [];
  const { harness, calls } = fakeAdapter(async (turn) => {
    await emitGoalCreate(turn, "self-enforced");
    return { reply: "pi handles it" };
  }, true);
  const result = await router(harness).turns.runTurn(stubTurn(emitted));
  assert.equal(calls.length, 1);
  assert.equal(result.reply, "pi handles it");
  assert.ok(emitted.every((item) => CONVERSATION_KINDS.has(item.kind)));
  assert.deepEqual(
    saves(emitted).map((goal) => goal.status),
    ["active"],
  );
});

test("a stopped turn pauses the goal instead of continuing it", async () => {
  const emitted: Item[] = [];
  const { harness, calls } = fakeAdapter(async (turn) => {
    await emitGoalCreate(turn, "interrupted work");
    return { reply: "", stopped: true };
  });
  await router(harness).turns.runTurn(stubTurn(emitted));
  assert.equal(calls.length, 1);
  assert.equal(savedGoal(emitted)?.status, "paused");
});

test("turns without a goal pass through untouched", async () => {
  const emitted: Item[] = [];
  const { harness, calls } = fakeAdapter(async () => ({ reply: "plain" }));
  const result = await router(harness).turns.runTurn(stubTurn(emitted));
  assert.equal(calls.length, 1);
  assert.equal(result.reply, "plain");
  assert.deepEqual(
    emitted.map((item) => item.kind),
    ["UserMessage"],
  );
  assert.deepEqual(saves(emitted), []);
});

test("an open goal from an earlier turn is picked up from the session", async () => {
  const emitted: Item[] = [];
  const prior = createGoalRecord({ objective: "carried over" });
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) return { reply: "forgot about the goal" };
    turn.goal!.status = "complete";
    return { reply: "now done" };
  });
  const result = await router(harness).turns.runTurn(stubTurn(emitted, { goal: prior }));
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.input, /carried over/);
  assert.equal(result.reply, "now done");
});

test("rounds without progress never waive the goal; only a user stop ends it", async () => {
  const emitted: Item[] = [];
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) await emitGoalCreate(turn, "spin forever");
    return round === 20 ? { reply: "stopped", stopped: true, stoppedByUser: true } : { reply: `round ${round}` };
  });
  const result = await router(harness).turns.runTurn(stubTurn(emitted));
  assert.equal(calls.length, 21);
  assert.doesNotMatch(result.reply, /waived/);
  assert.equal(savedGoal(emitted)?.status, "paused");
});

for (const harnessId of ["claude"] as const) {
  test(`${harnessId} preserves an active goal on infrastructure cancellation and resumes after reload`, async () => {
    const emitted: Item[] = [];
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
    assert.equal(savedGoal(emitted)?.status, "active");
    const resumed = fakeAdapter(async (turn, round) => {
      if (round === 0) return { reply: "continue" };
      assert.match(turn.input, /survive shutdown/);
      turn.goal!.status = "complete";
      return { reply: "verified" };
    });
    const result = await routed(resumed.harness).turns.runTurn(stubTurn([], { goal: openGoal(savedGoal(emitted)) }));
    assert.equal(resumed.calls.length, 2);
    assert.equal(result.reply, "verified");
  });
}

for (const harnessId of ["claude"] as const) {
  test(`${harnessId} persists user Stop when shutdown races with the real run signal`, async () => {
    const signals = createMemoryRunSignalStore();
    const cancel = new AbortController();
    const emitted: Item[] = [];
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
    assert.equal(openGoal(savedGoal(emitted))?.status, "paused");
  });
}

function goalTools(turn: HarnessTurnInput) {
  const ref = harnessToolContext(turn);
  ref.current = { humanTurn: true } as ToolContextRef["current"];
  const goal = createAgentTools(ref).find((tool) => tool.name === "goal")!;
  const call = (id: string, params: Record<string, unknown>) =>
    (goal.execute as unknown as (id: string, p: unknown) => Promise<{ content: Array<{ text?: string }> }>)(id, params);
  return { ref, call };
}

function earlierGoal(objective: string): GoalRecord {
  return createGoalRecord({ objective });
}

test("a person's message cancels the goal and registers a replacement, which the router then enforces", async () => {
  const emitted: Item[] = [];
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) {
      const { call } = goalTools(turn);
      await call("c1", { action: "update", status: "cancel", note: "user: cancel the old goal, start the new one" });
      await call("c2", { action: "create", objective: "broader research and sending" });
      return { reply: "replaced" };
    }
    assert.match(turn.input, /broader research and sending/);
    if (round > 1) return { reply: "", stopped: true };
    return { reply: "working" };
  });

  await router(harness).turns.runTurn(
    stubTurn(emitted, { goal: earlierGoal("old outreach goal"), turnWallClockMs: 600_000 }),
  );

  assert.ok(calls.length >= 2, "the replacement goal is enforced in the same turn");
  const goals = saves(emitted).map((g) => `${g.objective}:${g.status}`);
  assert.deepEqual(goals.slice(0, 2), ["old outreach goal:cancelled", "broader research and sending:active"]);
  assert.equal(savedGoal(emitted)?.objective, "broader research and sending");
  assert.equal(openGoal(savedGoal(emitted))?.status, "paused");
});

test("the agent cannot cancel its goal from a keep-going round", async () => {
  const emitted: Item[] = [];
  const refusals: string[] = [];
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) return { reply: "starting" };
    const { call } = goalTools(turn);
    const result = await call(`c${round}`, { action: "update", status: "cancel", note: "this is hopeless" });
    refusals.push(result.content.map((c) => c.text ?? "").join(""));
    if (round > 1) return { reply: "", stopped: true };
    return { reply: "giving up" };
  });

  await router(harness).turns.runTurn(
    stubTurn(emitted, { goal: earlierGoal("ship the migration"), turnWallClockMs: 600_000 }),
  );

  assert.equal(calls.length, 3, "the goal keeps going after the refused cancel");
  assert.match(refusals[0]!, /Only the user's own message can cancel/);
  assert.equal(savedGoal(emitted)?.status, "paused", "only the stop paused it; it was never cancelled");
});

test("the router reports the runtime each turn runs on, and the rule that routed it", async () => {
  const reported: unknown[] = [];
  const reply: Round = async (turn) => {
    await turn.emit({ kind: "AgentMessage", text: "done" });
    return { reply: "done" };
  };
  const routed = createHarnessRouter(
    new Map([["claude", fakeAdapter(reply).harness]]),
    createMockHarness(),
    async (_input, routedBy) => {
      routedBy("hard-task");
      return { harnessId: "claude", modelId: "claude-haiku-5-5" };
    },
  );
  await routed.turns.runTurn(stubTurn([], { onRuntime: (runtime) => reported.push(runtime) }));
  await router(fakeAdapter(reply).harness).turns.runTurn(
    stubTurn([], { onRuntime: (runtime) => reported.push(runtime) }),
  );
  assert.deepEqual(reported, [
    { harnessId: "claude", modelId: "claude-haiku-5-5", label: "Haiku 5.5", change: { rule: "hard-task" } },
    { harnessId: "claude", modelId: "claude-opus-5-5", label: "Opus 5.5" },
  ]);
});

async function completeSpendGoal(costUsd: number) {
  const emitted: Item[] = [];
  let reply = "";
  const { harness } = fakeAdapter(async (turn, round) => {
    if (round > 0) return { reply: "", stopped: true };
    const { call } = goalTools(turn);
    await call("c1", { action: "create", objective: "spend the budget", floor: { minUsd: 0.05 } });
    await turn.recordLlmRequest?.({
      turnSeq: null,
      step: 0,
      model: "claude-opus-5-5",
      truncated: false,
      usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1000, costUsd },
    });
    reply = (await call("c2", { action: "update", status: "complete", note: "spent it" })).content[0]!.text!;
    return { reply: "done" };
  });
  await router(harness).turns.runTurn(stubTurn(emitted));
  return reply;
}

test("a non-enforcing harness's recorded call cost counts toward a goal's spend floor", async () => {
  assert.doesNotMatch(await completeSpendGoal(0.06), /floor/i);
  assert.match(await completeSpendGoal(0.01), /floor/i);
});

test("a call without a recorded price stops a spend floor from blocking completion on a non-enforcing harness", async () => {
  assert.doesNotMatch(await completeSpendGoal(0), /floor/i);
});

test("a goal replaced during a router round is not charged for that round's calls", async () => {
  const goal = createGoalRecord({ objective: "lane A", floor: { minTurns: 10 } });
  const { harness } = fakeAdapter(async (turn, round) => {
    if (round === 0) {
      Object.assign(
        turn.goal!,
        createGoalRecord({ objective: "lane B", floor: { minTurns: 10 }, now: goal.createdAt + 1 }),
      );
      return { reply: "", modelCalls: 20 };
    }
    return { reply: "", stopped: true };
  });
  const emitted: Item[] = [];
  await router(harness).turns.runTurn(stubTurn(emitted, { goal }));
  assert.equal(goal.objective, "lane B");
  assert.ok(openGoal(goal));
  assert.match(
    emitted.map((entry) => JSON.stringify(entry)).join("\n"),
    /least\): 0\/10 turns/,
    "the floor prompt counts lane B's turns from zero",
  );
});

test("a goal created during a router round is charged for that round", async () => {
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) {
      await turn.saveGoal?.(createGoalRecord({ objective: "x", capTokens: 100 }));
      return { reply: "", modelCalls: 5, cacheUsage: { cacheRead: 0, cacheWrite: 0, uncachedInput: 100 } };
    }
    return { reply: "", stopped: true };
  });
  await router(harness).turns.runTurn(stubTurn([]));
  assert.match(calls[1]!.input, /token cap is exhausted \(100\/100/);
});

test("spend recorded after a goal is replaced mid-round is not credited to the replacement", async () => {
  const goal = createGoalRecord({ objective: "lane A" });
  const usage = { input: 10, output: 10, costUsd: 2 } as unknown as NonNullable<
    Parameters<NonNullable<HarnessTurnInput["recordLlmRequest"]>>[0]["usage"]
  >;
  const { harness, calls } = fakeAdapter(async (turn, round) => {
    if (round === 0) {
      Object.assign(
        turn.goal!,
        createGoalRecord({ objective: "lane B", floor: { minUsd: 1 }, now: goal.createdAt + 1 }),
      );
      await turn.recordLlmRequest?.({ usage } as never);
      return { reply: "" };
    }
    return { reply: "", stopped: true };
  });
  await router(harness).turns.runTurn(stubTurn([], { goal }));
  assert.match(calls[1]!.input, /least\): \$0\.0000\/\$1 — NOT met/);
});
