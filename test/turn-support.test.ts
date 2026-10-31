import test from "node:test";
import assert from "node:assert/strict";
import { turnToolContext, oneShotModelUtilities, oneShotRunner } from "../src/agent/turn-support.ts";
import { SECURITY_SCREEN_STEP, SECURITY_SCREEN_SYSTEM_PROMPT } from "../src/security/security-posture.ts";
import type { TurnLlmRequestRecord, AgentTurnInput, AgentTurnResult } from "../src/agent/agent.ts";

function capturingRunPrompt(reply = "one-shot reply"): {
  turns: AgentTurnInput[];
  runPrompt: (turn: AgentTurnInput) => Promise<AgentTurnResult>;
} {
  const turns: AgentTurnInput[] = [];
  return {
    turns,
    runPrompt: async (turn) => {
      turns.push(turn);
      return { reply };
    },
  };
}

test("agent adapters forward tool-result screening into their tool bridge", () => {
  const screenToolResult: NonNullable<AgentTurnInput["screenToolResult"]> = async () => ({ outcome: "allow" });
  const toolApprovalGate: NonNullable<AgentTurnInput["toolApprovalGate"]> = () => true;
  const ref = turnToolContext({ screenToolResult, toolApprovalGate, history: [] } as unknown as AgentTurnInput);
  assert.equal(ref.screenToolResult, screenToolResult);
  assert.equal(ref.toolApprovalGate, toolApprovalGate);
  assert.equal(ref.pausedOnApproval, false);
  assert.equal(ref.silentRequested, false);
});

test("the one-shot runner builds an isolated read-only turn with no history", async () => {
  const { turns, runPrompt } = capturingRunPrompt();
  const single = oneShotRunner(runPrompt);
  assert.equal(await single("be terse", "hello"), "one-shot reply");
  const turn = turns[0]!;
  assert.equal(turn.systemPrompt, "be terse");
  assert.equal(turn.input, "hello");
  assert.equal(turn.readOnly, true);
  assert.deepEqual(turn.history, []);
  assert.match(turn.session.id, /^oneshot-[0-9a-f]{16}$/);
  assert.equal(turn.runtime, undefined);
  assert.equal(turn.cancel, undefined);
  assert.equal(turn.recordLlmRequest, undefined);
  const emitted = await turn.emit({ type: "user", payload: { text: "x" }, scopeLabel: turn.scopeLabel });
  assert.equal(emitted.seq, 1);
  assert.equal(emitted.sessionId, turn.session.id);
  assert.equal((await turn.emit({ type: "assistant", payload: { text: "y" }, scopeLabel: turn.scopeLabel })).seq, 2);
});

test("the one-shot runner plumbs signal, instrumentation, and model override positionally", async () => {
  const { turns, runPrompt } = capturingRunPrompt("");
  const single = oneShotRunner(runPrompt);
  const cancel = new AbortController().signal;
  const recordModelCall = () => {};
  const recordLlmRequest = async () => {};
  assert.equal(await single("s", "p", cancel, { recordModelCall, recordLlmRequest }, "judge-model-1"), undefined);
  const turn = turns[0]!;
  assert.equal(turn.cancel, cancel);
  assert.equal(turn.recordModelCall, recordModelCall);
  assert.notEqual(turn.recordLlmRequest, undefined);
  assert.deepEqual(turn.runtime, { modelId: "judge-model-1" });
});

test("one-shot LLM records do not inherit synthetic turn coordinates", async () => {
  const recorded: TurnLlmRequestRecord[] = [];
  const runPrompt = async (turn: AgentTurnInput): Promise<AgentTurnResult> => {
    await turn.recordLlmRequest?.({ turnSeq: 3, step: 2, model: "m", truncated: false });
    return { reply: "ok" };
  };
  const single = oneShotRunner(runPrompt);
  await single("s", "p", undefined, {
    recordModelCall: () => {},
    recordLlmRequest: (rec) => {
      recorded.push(rec);
    },
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.turnSeq, null);
  assert.equal(recorded[0]!.step, 2);
});

test("judge overrides the model while oneShot keeps the agent default", async () => {
  const { turns, runPrompt } = capturingRunPrompt();
  const utilities = oneShotModelUtilities(oneShotRunner(runPrompt), "cheap-judge-model");
  await utilities.oneShot!("s", "p");
  await utilities.judge!("s", "p");
  assert.deepEqual(
    turns.map((turn) => turn.runtime?.modelId),
    [undefined, "cheap-judge-model"],
  );
});

test("without a configured judge model, judge falls back to the agent default model", async () => {
  const { turns, runPrompt } = capturingRunPrompt();
  const utilities = oneShotModelUtilities(oneShotRunner(runPrompt));
  await utilities.judge!("s", "p");
  assert.equal(turns[0]!.runtime, undefined);
});

test("routing judge cancellation reaches the model turn", async () => {
  const { turns, runPrompt } = capturingRunPrompt();
  const utilities = oneShotModelUtilities(oneShotRunner(runPrompt));
  const controller = new AbortController();
  await utilities.judge!("s", "p", controller.signal);
  assert.equal(turns[0]!.cancel, controller.signal);
  controller.abort();
  assert.equal(turns[0]!.cancel?.aborted, true);
});

test("security screening passes the abort signal and instrumentation through the one-shot runner", async () => {
  const { turns, runPrompt } = capturingRunPrompt('{"decision":"auto"}');
  const utilities = oneShotModelUtilities(oneShotRunner(runPrompt));
  const controller = new AbortController();
  const recordModelCall = () => {};
  const verdict = await utilities.screenSecurity!({
    payload: "suspicious payload",
    signal: controller.signal,
    recordModelCall,
  });
  assert.deepEqual(verdict, { decision: "auto" });
  const turn = turns[0]!;
  assert.equal(turn.systemPrompt, SECURITY_SCREEN_SYSTEM_PROMPT);
  assert.equal(turn.input, "suspicious payload");
  assert.equal(turn.cancel, controller.signal);
  assert.equal(turn.recordModelCall, recordModelCall);
});

test("shared agent security screens use auxiliary coordinates", async () => {
  const recorded: TurnLlmRequestRecord[] = [];
  const runPrompt = async (turn: AgentTurnInput): Promise<AgentTurnResult> => {
    await turn.recordLlmRequest?.({ turnSeq: 7, step: 0, model: "claude-oneshot", truncated: false });
    return { reply: '{"decision":"auto"}' };
  };
  const utilities = oneShotModelUtilities(oneShotRunner(runPrompt));
  const verdict = await utilities.screenSecurity!({
    payload: "suspicious payload",
    signal: new AbortController().signal,
    recordModelCall: () => {},
    recordLlmRequest: (rec) => {
      recorded.push(rec);
    },
  });
  assert.deepEqual(verdict, { decision: "auto" });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.turnSeq, null);
  assert.equal(recorded[0]!.step, SECURITY_SCREEN_STEP);
  assert.equal(recorded[0]!.model, "claude-oneshot");
});

test("agent adapters hand the session goal and its saver to the tool context, ignoring legacy snapshots", async () => {
  const { createGoalRecord } = await import("../src/agent/goal.ts");
  const goal = createGoalRecord({ objective: "carry the goal across turns" });
  const history = [{ type: "system", payload: { kind: "goal", goal }, seq: 0 }] as unknown as AgentTurnInput["history"];
  assert.equal(turnToolContext({ history } as unknown as AgentTurnInput).goal, null);
  const saveGoal = async () => {};
  const ref = turnToolContext({ history: [], goal, saveGoal } as unknown as AgentTurnInput);
  assert.equal(ref.goal, goal);
  assert.equal(ref.saveGoal, saveGoal);
  assert.equal(ref.goalRound, undefined);
  assert.equal(turnToolContext({ history: [], goal, continueTurn: true } as unknown as AgentTurnInput).goalRound, 1);
});
