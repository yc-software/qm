import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type ExceptionsKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<ExceptionsKey>({
    id: "finance-flag-exceptions",
    difficulty: "hard",
    family: "finance",
    origin: "research",
    evidence:
      "Garry Tan's Own Your Intelligence talk (17:43): finance staff workflows such as reviewing records against policy.",
    sources: ["https://www.youtube.com/watch?v=eRrc1pUY5oU&t=1063s"],
    outputs: ["output/exceptions.json"],
    generate,
    prompt: () =>
      'Work out the expense rules from audit/reviewed.csv (read audit/README.md), then review finance/expenses.csv against them. Write output/exceptions.json as {"rules": {"meal_limit_per_attendee": n, "receipt_required_above": n, "travel_approval_above": n}, "exceptions": [{"id", "rule"}, ...]} using the rule codes from the audit; every code the audit uses is in scope, not only the three with thresholds. An expense that breaks two rules appears twice; expenses that break nothing must not appear. Write a script.',
    verify,
  });
}

export function gold(f: Fixture<ExceptionsKey>): Record<string, string> {
  const k = f.key;
  return {
    "output/exceptions.json": JSON.stringify({
      rules: {
        meal_limit_per_attendee: k.mealLimit,
        receipt_required_above: k.receiptFloor,
        travel_approval_above: k.travelFloor,
      },
      exceptions: k.expected.map((e) => ({ id: e.split("|")[0], rule: e.split("|")[1] })),
    }),
  };
}
