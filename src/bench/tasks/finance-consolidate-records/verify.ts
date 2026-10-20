import { f1, num, parseCsv } from "../../core/text.ts";
import type { Check, Outputs } from "../../core/types.ts";
import type { ConsolidateKey } from "./generate.ts";

export async function verify(outputs: Outputs, key: ConsolidateKey): Promise<Check[]> {
  const rows = parseCsv((await outputs.read("output/ledger.csv")) ?? "");
  const header = rows.length > 0 ? Object.keys(rows[0]!).join(",") : "";
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const refs = new Map<string, number>();
  let iso = 0;
  for (const row of rows) {
    const src = (row.source ?? "").toLowerCase();
    const amount = num(row.amount);
    sums[src] = (sums[src] ?? 0) + (Number.isFinite(amount) ? amount : 0);
    counts[src] = (counts[src] ?? 0) + 1;
    refs.set(row.ref ?? "", (refs.get(row.ref ?? "") ?? 0) + 1);
    if (/^2026-08-\d{2}$/.test(row.date ?? "")) iso++;
  }
  const rowKey = (x: { date?: unknown; amount?: unknown; vendor?: unknown; source?: unknown; ref?: unknown }): string =>
    `${x.date}|${num(x.amount).toFixed(2)}|${String(x.vendor ?? "").toLowerCase()}|${String(x.source ?? "").toLowerCase()}|${x.ref}`;
  const rowsMatch = f1(key.rows.map(rowKey), rows.map(rowKey));
  const sources = Object.keys(key.counts);
  const sumScore =
    sources.filter((s) => Math.abs((sums[s] ?? 0) - (key.totals[s] ?? 0)) < 0.011 * (key.counts[s] ?? 1)).length /
    sources.length;
  const countScore = sources.filter((s) => counts[s] === key.counts[s]).length / sources.length;
  const dupesKept = key.duplicateRefs.filter((d) => (refs.get(d) ?? 0) > 1).length;
  return [
    { id: "columns", score: header === "date,amount,vendor,source,ref" ? 1 : 0 },
    { id: "rows-match-key", score: rowsMatch },
    { id: "row-counts", score: countScore },
    { id: "totals-per-source", score: sumScore },
    { id: "iso-dates", score: rows.length === 0 ? 0 : iso / rows.length },
    {
      id: "card-settlements-deduped",
      score: rows.length > 0 && dupesKept === 0 && (counts.card ?? 0) > 0 ? 1 : 0,
      detail: `${dupesKept} kept`,
    },
    {
      id: "paypal-settlements-deduped",
      score: rows.length > 0 && key.paypalDuplicateRefs.every((d) => !refs.has(d)) && (counts.paypal ?? 0) > 0 ? 1 : 0,
    },
    {
      id: "sign-convention",
      score:
        rows.length > 0 &&
        rows
          .filter((x) => ["card", "paypal", "payroll"].includes((x.source ?? "").toLowerCase()))
          .every((x) => num(x.amount) < 0)
          ? 1
          : 0,
    },
  ];
}
