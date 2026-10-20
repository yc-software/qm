import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type AdviceKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<AdviceKey>({
    id: "grounded-advice-evidence",
    difficulty: "hard",
    family: "founder-support",
    origin: "research",
    evidence:
      "Garry Tan's Own Your Intelligence talk (14:48): founder advice grounded in prior conversations and the firm's own guidance rather than generic answers.",
    sources: ["https://www.youtube.com/watch?v=eRrc1pUY5oU&t=888s"],
    outputs: ["output/advice.json"],
    generate,
    prompt: () =>
      "Answer inbox/question.md the way this firm advises founders. There is no written rule; memos/ holds thirty past cases and memos/README.md defines the arithmetic. Work out from the memos what runway and growth levels drive each recommendation, then apply that to metrics/metrics.csv. " +
      'Write output/advice.json with keys: latest_mrr (number), mom_growth_pct (number, one decimal), implied_arr (number), runway_months (number), recommendation ("bridge", "priced_round" or "cut_burn"), runway_threshold_months (number, the inferred cutoff), growth_threshold_pct (number, the inferred cutoff), sources (array of file paths).',
    verify,
  });
}

export function gold(f: Fixture<AdviceKey>): Record<string, string> {
  const k = f.key;
  return {
    "output/advice.json": JSON.stringify({
      latest_mrr: k.latestMrr,
      mom_growth_pct: k.growthPct,
      implied_arr: k.impliedArr,
      runway_months: k.runwayMonths,
      recommendation: k.recommendation,
      runway_threshold_months: k.runwayThreshold,
      growth_threshold_pct: k.growthThreshold,
      sources: ["metrics/metrics.csv", "memos/README.md", "inbox/question.md"],
    }),
  };
}
