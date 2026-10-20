import { type Rng, rng } from "../../core/rng.ts";
import { csv } from "../../core/text.ts";
import { type Fixture } from "../../core/types.ts";
import { companyNames, slugify } from "../../families/portfolio.ts";

interface TriageEntry {
  slug: string;
  reasons: string[];
}

export interface TriageKey {
  flagged: TriageEntry[];
  runwayBelow: number;
  staleAfter: number;
  growthBelow: number;
}

interface Rules {
  runwayBelow: number;
  staleAfter: number;
  growthBelow: number;
}

interface Metrics {
  slug: string;
  name: string;
  runway_months: number;
  days_since_update: number;
  mrr_growth_pct: number;
  open_incident: string;
}

function reasonsFor(c: Metrics, rules: Rules): string[] {
  const reasons: string[] = [];
  if (c.runway_months < rules.runwayBelow) reasons.push("low-runway");
  if (c.days_since_update > rules.staleAfter) reasons.push("stale-update");
  if (c.mrr_growth_pct < rules.growthBelow) reasons.push("negative-growth");
  if (c.open_incident === "yes") reasons.push("open-incident");
  return reasons;
}

function metrics(r: Rng, name: string, over: Partial<Metrics> = {}): Metrics {
  return {
    slug: slugify(name),
    name,
    runway_months: r.int(2, 20),
    days_since_update: r.int(1, 90),
    mrr_growth_pct: r.int(-15, 25),
    open_incident: r.chance(0.12) ? "yes" : "no",
    ...over,
  };
}

function boundaryCases(r: Rng, names: string[], { runwayBelow, staleAfter, growthBelow }: Rules): Metrics[] {
  return [
    metrics(r, names[0]!, {
      runway_months: runwayBelow - 1,
      days_since_update: 5,
      mrr_growth_pct: 5,
      open_incident: "no",
    }),
    metrics(r, names[1]!, { runway_months: runwayBelow, days_since_update: 5, mrr_growth_pct: 5, open_incident: "no" }),
    metrics(r, names[2]!, {
      runway_months: 15,
      days_since_update: staleAfter + 1,
      mrr_growth_pct: 5,
      open_incident: "no",
    }),
    metrics(r, names[3]!, { runway_months: 15, days_since_update: staleAfter, mrr_growth_pct: 5, open_incident: "no" }),
    metrics(r, names[4]!, {
      runway_months: 15,
      days_since_update: 5,
      mrr_growth_pct: growthBelow,
      open_incident: "no",
    }),
    metrics(r, names[5]!, {
      runway_months: 15,
      days_since_update: 5,
      mrr_growth_pct: growthBelow - 1,
      open_incident: "no",
    }),
  ];
}

function currentRows(r: Rng, current: Metrics[]): Array<Array<string | number>> {
  const row = (c: Metrics, asOf: string): Array<string | number> => [
    c.slug,
    c.name,
    c.runway_months,
    c.days_since_update,
    c.mrr_growth_pct,
    c.open_incident,
    asOf,
  ];
  const rows: Array<Array<string | number>> = [];
  for (const c of current) {
    const asOf = `2026-09-${String(r.int(10, 20)).padStart(2, "0")}`;
    if (r.chance(0.15)) rows.push(row(metrics(r, c.name), `2026-09-${String(r.int(1, 9)).padStart(2, "0")}`));
    rows.push(row(c, asOf));
  }
  return r.shuffle(rows);
}

export function generate(seed: number): Fixture<TriageKey> {
  const r = rng(seed * 6007 + 2);
  const rules: Rules = {
    runwayBelow: r.int(4, 8),
    staleAfter: r.pick([30, 45, 60]),
    growthBelow: r.pick([-5, -3, -1, 0]),
  };
  const names = companyNames(r, 300);
  const historyNames = names.slice(0, 120);
  const boundary = boundaryCases(r, historyNames, rules);
  const history = [...boundary, ...historyNames.slice(6).map((n) => metrics(r, n))];
  const current = names.slice(120).map((n) => metrics(r, n));
  const flagged: TriageEntry[] = current
    .map((c) => ({ slug: c.slug, reasons: reasonsFor(c, rules), runway: c.runway_months }))
    .filter((c) => c.reasons.length > 0)
    .sort((a, b) => a.runway - b.runway || a.slug.localeCompare(b.slug))
    .map(({ slug, reasons }) => ({ slug, reasons }));
  const files = {
    "portfolio/companies.csv": csv(
      ["slug", "name", "runway_months", "days_since_update", "mrr_growth_pct", "open_incident", "as_of"],
      currentRows(r, current),
    ),
    "history/decisions.csv": csv(
      ["slug", "runway_months", "days_since_update", "mrr_growth_pct", "open_incident", "flagged", "reasons"],
      r.shuffle(history).map((c) => {
        const reasons = reasonsFor(c, rules);
        return [
          c.slug,
          c.runway_months,
          c.days_since_update,
          c.mrr_growth_pct,
          c.open_incident,
          reasons.length ? "yes" : "no",
          reasons.join(";"),
        ];
      }),
    ),
    "history/README.md":
      "Every triage decision the partners made last quarter, with the reason codes they used. The rules were never written down; the decisions are the rules. Ordering convention for the list: runway ascending, then slug.\n\nWhen you write the rules down: low_runway_below_months is n when a runway strictly under n months gets low-runway, stale_after_days is n when strictly more than n days since the last update gets stale-update, and negative_growth_below_pct is n when growth strictly under n percent gets negative-growth.\n\nportfolio/companies.csv is an append-only export: a slug can appear more than once, and only its row with the latest as_of counts.\n",
  };
  return { files, privateFiles: {}, key: { flagged, ...rules } };
}
