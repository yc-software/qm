import { asArray, asRecord, close, num, parseJson, str } from "../../core/text.ts";
import type { Check, Outputs } from "../../core/types.ts";
import type { AdviceKey } from "./generate.ts";

export async function verify(outputs: Outputs, key: AdviceKey): Promise<Check[]> {
  const o = asRecord(parseJson(await outputs.read("output/advice.json")));
  const sources = asArray(o.sources).map(str);
  return [
    { id: "latest-mrr-restated", score: close(num(o.latest_mrr), key.latestMrr, 1) ? 1 : 0 },
    { id: "growth", score: close(num(o.mom_growth_pct), key.growthPct, 0.15) ? 1 : 0 },
    { id: "implied-arr", score: close(num(o.implied_arr), key.impliedArr, 12) ? 1 : 0 },
    { id: "runway", score: close(num(o.runway_months), key.runwayMonths, 0) ? 1 : 0 },
    { id: "recommendation", score: str(o.recommendation) === key.recommendation ? 1 : 0 },
    {
      id: "inferred-runway-threshold",
      score: close(num(o.runway_threshold_months), key.runwayThreshold, 0) ? 1 : 0,
    },
    {
      id: "inferred-growth-threshold",
      score: close(num(o.growth_threshold_pct), key.growthThreshold, 0.5) ? 1 : 0,
    },
    {
      id: "cites-metrics-and-memos",
      score: sources.includes("metrics/metrics.csv") && sources.some((s) => s.startsWith("memos/")) ? 1 : 0,
    },
  ];
}
