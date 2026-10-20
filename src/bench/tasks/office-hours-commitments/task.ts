import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type CommitmentsKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<CommitmentsKey>({
    id: "office-hours-commitments",
    difficulty: "easy",
    family: "office-hours",
    origin: "research",
    evidence:
      "Garry Tan's Own Your Intelligence talk (17:01): tracking commitments, owners and deadlines out of meetings.",
    sources: ["https://www.youtube.com/watch?v=eRrc1pUY5oU&t=934s"],
    outputs: ["output/commitments.json", "output/open.json"],
    generate,
    prompt: (f) =>
      `Read the transcript in transcripts/ and extract every concrete commitment: something a named person agreed to do by a date. Dates are often relative to the meeting date in the transcript header. When someone restates a date later in the meeting, the restated date wins. Write output/commitments.json as a JSON array of {"owner", "task", "due"} with due as YYYY-MM-DD. Leave out ideas, questions, declines, anything without a date, and anything a person other than the two owners agreed to do. Owners are ${f.key.founder} and ${f.key.partner}.`,
    followUp: (f) => {
      const c = f.key.corrections;
      return `Corrections from ${f.key.partner}: the commitment to ${c.movedA.task} is now due ${c.movedA.due}; the one to ${c.movedB.task} moves to ${c.movedB.due}; the commitment to ${c.cancelled.task} is cancelled; and ${f.key.partner} committed to ${c.added.task} by ${c.added.due}. Update output/commitments.json, then read tracking/completed.md and write output/open.json: the commitments not yet completed as of ${f.key.asOf}, each {"owner", "task", "due", "overdue"} where overdue is true when due is before ${f.key.asOf}.`;
    },
    verify,
  });
}

export function gold(f: Fixture<CommitmentsKey>): Record<string, string> {
  return {
    "output/commitments.json": JSON.stringify(f.key.afterCorrections),
    "output/open.json": JSON.stringify(f.key.open),
  };
}
