import { test } from "node:test";
import assert from "node:assert/strict";
import { modelBudgetRefusal } from "../src/core/turn-error.ts";

test("modelBudgetRefusal explains gateway budget exhaustion in plain words", () => {
  assert.equal(
    modelBudgetRefusal(
      'OpenAI API error (429): {"message":"ExceededBudget: Team=team-a over 1d budget. Spend=$1011.5675, Limit=$1000.00","type":"budget_exceeded"}',
    ),
    "This workspace has used up its $1,000 daily model budget, so I can't run until it resets. An admin can raise the limit.",
  );
  assert.equal(
    modelBudgetRefusal(
      "Model provider API error (budget_exceeded): ExceededBudget: Key over 30d budget. Spend=$10000.5000, Limit=$10000.00",
    ),
    "This workspace has used up its $10,000 30-day model budget, so I can't run until it resets. An admin can raise the limit.",
  );
  assert.equal(
    modelBudgetRefusal("Budget has been exceeded! Team=team-a Current cost: 26.1, Max budget: 25.5"),
    "This workspace has used up its $25.5 model budget, so I can't run until it resets. An admin can raise the limit.",
  );
  assert.equal(
    modelBudgetRefusal("ExceededBudget: Team=team-a over 2h budget.", "Ask the platform team."),
    "This workspace has used up its 2-hour model budget, so I can't run until it resets. Ask the platform team.",
  );
});

test("modelBudgetRefusal leaves every other provider failure alone", () => {
  for (const message of [
    'OpenAI API error (429): {"message":"Rate limit reached","type":"rate_limit_error"}',
    "insufficient_quota: You exceeded your current quota",
    "thinking.budget_tokens must be at least 1500",
    "socket hang up",
  ])
    assert.equal(modelBudgetRefusal(message), undefined, message);
});
