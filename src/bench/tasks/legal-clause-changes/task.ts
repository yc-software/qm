import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type RedlineKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<RedlineKey>({
    id: "legal-clause-changes",
    difficulty: "medium",
    family: "legal",
    origin: "observed",
    evidence:
      "Proposed legal workflow for qm: diff a counterparty's redline against the standard form and route material changes to a partner. Not a workflow Garry listed.",
    sources: ["https://qm.ycombinator.com/", "https://github.com/yc-software/qm"],
    outputs: ["output/clause-review.json"],
    generate,
    prompt: () =>
      'Compare each redline in legal/redlines/ against legal/template-safe.md clause by clause, following legal/review-policy.md for how to identify clauses and what needs a partner. Write output/clause-review.json as a JSON object keyed by redline file name, each value {"changed": [template clause ids whose substance differs, plus removed clauses and NEW-<n> for added ones], "needs_review": [the subset the policy sends to a partner]}. Write a script.',
    verify,
  });
}

export function gold(f: Fixture<RedlineKey>): Record<string, string> {
  const out: Record<string, { changed: string[]; needs_review: string[] }> = {};
  for (const [name, v] of Object.entries(f.key.redlines))
    out[name] = { changed: v.changed, needs_review: v.needsReview };
  return { "output/clause-review.json": JSON.stringify(out) };
}
