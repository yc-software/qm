import test from "node:test";
import assert from "node:assert/strict";
import { harnessToolContext, oneShotModelUtilities, oneShotRunner } from "../src/harness/harness-shared.ts";
import { SECURITY_SCREEN_SYSTEM_PROMPT } from "../src/security/security-posture.ts";
import type { HarnessTurnInput, HarnessTurnResult } from "../src/harness/harness.ts";

function capturingRunPrompt(reply = "one-shot reply"): {
  turns: HarnessTurnInput[];
  runPrompt: (turn: HarnessTurnInput) => Promise<HarnessTurnResult>;
} {
  const turns: HarnessTurnInput[] = [];
  return {
    turns,
    runPrompt: async (turn) => {
      turns.push(turn);
      return { reply };
    },
  };
}

test("harness adapters forward external-content screening into their tool bridge", () => {
  const screenExternalContent: NonNullable<HarnessTurnInput["screenExternalContent"]> = async () => ({
    decision: "auto",
  });
  const toolApprovalGate: NonNullable<HarnessTurnInput["toolApprovalGate"]> = () => true;
  const ref = harnessToolContext({ screenExternalContent, toolApprovalGate } as HarnessTurnInput);
  assert.equal(ref.screenExternalContent, screenExternalContent);
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
  assert.equal(turn.recordLlmRequest, recordLlmRequest);
  assert.deepEqual(turn.runtime, { modelId: "judge-model-1" });
});

test("judge overrides the model while oneShot keeps the harness default", async () => {
  const { turns, runPrompt } = capturingRunPrompt();
  const utilities = oneShotModelUtilities(oneShotRunner(runPrompt), "cheap-judge-model");
  await utilities.oneShot!("s", "p");
  await utilities.judge!("s", "p");
  assert.deepEqual(
    turns.map((turn) => turn.runtime?.modelId),
    [undefined, "cheap-judge-model"],
  );
});

test("without a configured judge model, judge falls back to the harness default model", async () => {
  const { turns, runPrompt } = capturingRunPrompt();
  const utilities = oneShotModelUtilities(oneShotRunner(runPrompt));
  await utilities.judge!("s", "p");
  assert.equal(turns[0]!.runtime, undefined);
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
