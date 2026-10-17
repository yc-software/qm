import { asArray, asRecord, f1, parseJson, str } from "../../core/text.ts";
import type { Check, Outputs } from "../../core/types.ts";
import type { RedlineKey } from "./generate.ts";

export async function verify(outputs: Outputs, key: RedlineKey): Promise<Check[]> {
  const o = asRecord(parseJson(await outputs.read("output/clause-review.json")));
  const names = Object.keys(key.redlines);
  const entry = (name: string): Record<string, unknown> => asRecord(o[name] ?? o[name.replace(/\.md$/, "")]);
  const up = (v: unknown): string =>
    str(v)
      .toUpperCase()
      .replace(/^(\d+)$/, "C$1");
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const changedScores = names.map((n) => f1(key.redlines[n]!.changed, asArray(entry(n).changed).map(up)));
  const reviewScores = names.map((n) => f1(key.redlines[n]!.needsReview, asArray(entry(n).needs_review).map(up)));
  const formattingIgnored = names.map((n) => {
    const listed = new Set(asArray(entry(n).changed).map(up));
    const fo = key.redlines[n]!.formattingOnly;
    return listed.size === 0 ? 0 : fo.filter((id) => !listed.has(id)).length / fo.length;
  });
  return [
    { id: "changed-clauses", score: mean(changedScores) },
    { id: "needs-review", score: mean(reviewScores) },
    { id: "formatting-and-renumbering-ignored", score: mean(formattingIgnored) },
  ];
}
