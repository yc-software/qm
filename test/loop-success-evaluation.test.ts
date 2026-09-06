import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSuccess, type JudgeVerdict, type SuccessCheckResult } from "../src/loops/success-evaluation.ts";

const passing = (command: string): SuccessCheckResult => ({ command, passed: true });
const judgeSays = (met: boolean, reason: string) => async (): Promise<JudgeVerdict> => ({ met, reason });

test("a failing deterministic check short-circuits before any model is asked", async () => {
  let judgeCalls = 0;
  const verdict = await evaluateSuccess({
    condition: "tests pass",
    attempt: 1,
    checks: ["npm test", "npm run lint"],
    runCheck: async (command) => ({ command, passed: command !== "npm test", detail: "3 failing" }),
    judge: async () => {
      judgeCalls += 1;
      return { met: true, reason: "looks fine" };
    },
  });
  assert.equal(verdict.outcome, "continue");
  assert.equal(verdict.judged, false);
  assert.equal(judgeCalls, 0);
  assert.match(verdict.reason, /npm test/);
  assert.deepEqual(
    verdict.checks.map((c) => c.command),
    ["npm test"],
  );
});

test("checks passing is a floor, not a verdict — the judge still decides", async () => {
  const verdict = await evaluateSuccess({
    condition: "the issue has a linked PR",
    attempt: 1,
    checks: ["npm test"],
    runCheck: async (command) => passing(command),
    judge: judgeSays(false, "no PR is linked to the issue yet"),
  });
  assert.equal(verdict.outcome, "continue");
  assert.equal(verdict.judged, true);
  assert.equal(verdict.reason, "no PR is linked to the issue yet");
});

test("the judge's reason is what carries into the next turn as guidance", async () => {
  const verdict = await evaluateSuccess({
    condition: "the reply answers the customer's question",
    attempt: 2,
    runCheck: async (command) => passing(command),
    judge: judgeSays(false, "the refund window was not addressed"),
  });
  assert.equal(verdict.outcome, "continue");
  assert.equal(verdict.reason, "the refund window was not addressed");
});

test("a met condition ends the item", async () => {
  const verdict = await evaluateSuccess({
    condition: "a PR is linked and CI is green",
    attempt: 3,
    checks: ["gh pr checks"],
    runCheck: async (command) => passing(command),
    judge: judgeSays(true, "PR 12 is linked and green"),
  });
  assert.equal(verdict.outcome, "met");
  assert.equal(verdict.reason, "PR 12 is linked and green");
});

test("the bound in the condition parks the item instead of looping forever", async () => {
  const verdict = await evaluateSuccess({
    condition: "a PR is linked, or park after 5 turns",
    attempt: 5,
    maxAttempts: 5,
    runCheck: async (command) => passing(command),
    judge: judgeSays(false, "still no reproduction"),
  });
  assert.equal(verdict.outcome, "park");
  assert.equal(verdict.reason, "attempt cap (5) reached: still no reproduction");
});

test("a failing check at the bound parks rather than retrying", async () => {
  const verdict = await evaluateSuccess({
    condition: "tests pass",
    attempt: 4,
    maxAttempts: 4,
    checks: ["npm test"],
    runCheck: async (command) => ({ command, passed: false }),
    judge: judgeSays(true, "unreachable"),
  });
  assert.equal(verdict.outcome, "park");
  assert.equal(verdict.judged, false);
});

test("with no bound set an unmet condition keeps working", async () => {
  const verdict = await evaluateSuccess({
    condition: "the queue is empty",
    attempt: 99,
    runCheck: async (command) => passing(command),
    judge: judgeSays(false, "4 items left"),
  });
  assert.equal(verdict.outcome, "continue");
});
