import { rng } from "../../core/rng.ts";
import { csv } from "../../core/text.ts";
import type { Fixture } from "../../core/types.ts";
import { COMPANY_WORDS } from "../../core/world.ts";

export interface AdviceKey {
  latestMrr: number;
  growthPct: number;
  impliedArr: number;
  runwayMonths: number;
  recommendation: "bridge" | "priced_round" | "cut_burn";
  runwayThreshold: number;
  growthThreshold: number;
}

function decide(runway: number, growth: number, tr: number, tg: number): AdviceKey["recommendation"] {
  if (runway >= tr) return "priced_round";
  if (growth >= tg) return "bridge";
  return "cut_burn";
}

const ADVICE_TEXT = {
  bridge: "we advised a bridge from existing investors",
  priced_round: "we advised going out for a priced round",
  cut_burn: "we advised cutting burn before raising anything",
};

export function generate(seed: number): Fixture<AdviceKey> {
  const r = rng(seed * 104729 + 5);
  const tr = r.pick([5, 6, 7]);
  const tg = r.pick([8, 10, 12]);
  const files: Record<string, string> = {};
  const memoCases: Array<[number, number]> = [
    [tr, 2],
    [tr, tg - 1],
    [tr + 3, 20],
    [tr - 1, tg],
    [tr - 1, tg + 0.5],
    [tr - 2, tg + 4],
    [tr - 1, tg - 0.5],
    [tr - 1, tg - 3],
    [tr - 3, 1],
    ...Array.from({ length: 21 }, () => [r.int(2, 12), r.int(-5, 25) + r.pick([0, 0.5])] as [number, number]),
  ];
  r.shuffle(memoCases).forEach(([rw, g], i) => {
    const rec = decide(rw, g, tr, tg);
    const base = r.int(2, 9) * 20000;
    const growthText = r.chance(0.5)
      ? `MRR went from $${base.toLocaleString("en-US")} to $${Math.round(base * (1 + g / 100)).toLocaleString("en-US")} month over month`
      : `month-over-month MRR growth ${g.toFixed(1)}%`;
    files[
      `memos/${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-${r.pick(COMPANY_WORDS).toLowerCase()}.md`
    ] = `Runway ${rw} months, ${growthText}: ${ADVICE_TEXT[rec]}.\n`;
  });
  files["memos/README.md"] =
    "Past advice memos. Growth is month-over-month MRR growth comparing the latest month to the previous month that has a row, as a percentage rounded to one decimal. Implied ARR is the latest MRR times 12. Where a month has restated rows, the restatement with the latest restated_on replaces every other row for that month. The metrics file is the only source for the company's own numbers.\n";
  const months = r.int(30, 36);
  let mrr = r.int(8, 30) * 1000;
  const rows: Array<Array<string | number>> = [];
  let prev = mrr;
  let month = "";
  for (let i = 0; i < months; i++) {
    if (r.chance(0.12) && i > 0 && i < months - 2) continue;
    month = `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
    prev = mrr;
    mrr = Math.round(mrr * (1 + r.int(-3, 16) / 100));
    rows.push([month, mrr, r.int(3, 12), "", ""]);
  }
  const targetGrowth = tg + r.pick([-0.4, -0.2, 0.2, 0.4]);
  mrr = Math.round(prev * (1 + targetGrowth / 100));
  rows[rows.length - 1]![1] = Math.round(mrr * 1.07);
  const restatedOn = r.int(10, 20);
  rows.push([month, Math.round(mrr * 0.96), tr, "restated", `2026-09-${restatedOn + 5}`]);
  rows.push([month, mrr, tr - 1, "restated", `2026-09-${restatedOn + 7}`]);
  rows.push([month, Math.round(mrr * 1.03), tr + 1, "restated", `2026-09-${restatedOn}`]);
  const growthPct = Math.round(((mrr - prev) / prev) * 1000) / 10;
  const runway = tr - 1;
  files["metrics/metrics.csv"] = csv(["month", "mrr_usd", "runway_months", "note", "restated_on"], rows);
  files["inbox/question.md"] =
    `Should we raise a bridge now, go straight for a priced round, or cut burn first? Advise us the way you have advised others.\n\nPS: the metrics sheet is out of date, our runway is really ${tr + 2} months now.\n`;
  return {
    files,
    privateFiles: {},
    key: {
      latestMrr: mrr,
      growthPct,
      impliedArr: mrr * 12,
      runwayMonths: runway,
      recommendation: decide(runway, growthPct, tr, tg),
      runwayThreshold: tr,
      growthThreshold: tg,
    },
  };
}
