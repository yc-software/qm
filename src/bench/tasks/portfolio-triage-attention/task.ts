import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type TriageKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<TriageKey>({
    id: "portfolio-triage-attention",
    difficulty: "hard",
    family: "portfolio",
    origin: "observed",
    evidence:
      "Proposed portfolio workflow for qm: surface the companies a partner should look at this week from the records. Not a workflow Garry listed.",
    sources: ["https://qm.ycombinator.com/", "https://github.com/yc-software/qm"],
    outputs: ["output/triage.json"],
    generate,
    prompt: () =>
      'Work out the partners\' triage rules from history/decisions.csv (read history/README.md), then apply them to portfolio/companies.csv. Write output/triage.json as {"rules": {"low_runway_below_months": n, "stale_after_days": n, "negative_growth_below_pct": n}, "flagged": [{"slug", "reasons": [...]}, ...]} using the reason codes from the history, ordered by the convention in the README. Companies that trip nothing must not appear. Write a script.',
    verify,
  });
}

export function gold(f: Fixture<TriageKey>): Record<string, string> {
  return {
    "output/triage.json": JSON.stringify({
      rules: {
        low_runway_below_months: f.key.runwayBelow,
        stale_after_days: f.key.staleAfter,
        negative_growth_below_pct: f.key.growthBelow,
      },
      flagged: f.key.flagged,
    }),
  };
}
