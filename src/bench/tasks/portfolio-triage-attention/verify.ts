import { asArray, asRecord, close, f1, num, orderScore, parseJson, str } from "../../core/text.ts";
import { type Check, type Outputs } from "../../core/types.ts";
import { type TriageKey } from "./generate.ts";

function reasonList(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(str) : str(value).split(/[;,]/);
  return parts.map((x) => x.trim().toLowerCase()).filter(Boolean);
}

export async function verify(outputs: Outputs, key: TriageKey): Promise<Check[]> {
  const o = asRecord(parseJson(await outputs.read("output/triage.json")));
  const rules = asRecord(o.rules);
  const rows = asArray(o.flagged).map(asRecord);
  const got = new Map(rows.map((r) => [str(r.slug).toLowerCase(), reasonList(r.reasons)] as const));
  const reasonScores = key.flagged.map((e) => f1(e.reasons, got.get(e.slug) ?? []));
  return [
    { id: "inferred-runway-rule", score: close(num(rules.low_runway_below_months), key.runwayBelow, 0) ? 1 : 0 },
    { id: "inferred-stale-rule", score: close(num(rules.stale_after_days), key.staleAfter, 0) ? 1 : 0 },
    { id: "inferred-growth-rule", score: close(num(rules.negative_growth_below_pct), key.growthBelow, 0) ? 1 : 0 },
    {
      id: "flagged-set",
      score: f1(
        key.flagged.map((e) => e.slug),
        [...got.keys()],
      ),
    },
    { id: "reasons", score: reasonScores.reduce((a, b) => a + b, 0) / key.flagged.length },
    {
      id: "order",
      score: orderScore(
        key.flagged.map((e) => e.slug),
        rows.map((r) => str(r.slug)),
      ),
    },
  ];
}
