import { close, num, parseCsv } from "../../core/text.ts";
import { type Check, type Outputs } from "../../core/types.ts";
import { type UpdateKey } from "./generate.ts";

export async function verify(outputs: Outputs, key: UpdateKey): Promise<Check[]> {
  const rows = parseCsv((await outputs.read("output/companies.csv")) ?? "");
  const by = new Map(rows.map((r) => [r.slug ?? "", r] as const));
  let correct = 0;
  let untouched = 0;
  for (const e of key.expected) {
    const got = by.get(e.slug);
    if (got && close(num(got.mrr_usd), e.mrr_usd, 1)) correct++;
    if (got && num(got.headcount) === e.headcount) correct++;
    if (got && got.last_update === e.last_update) correct++;
    if (got?.name === e.name) untouched++;
    if (got?.sector === e.sector) untouched++;
  }
  const header = rows.length > 0 ? Object.keys(rows[0]!) : [];
  return [
    { id: "columns", score: header.join(",") === key.header.join(",") ? 1 : 0 },
    { id: "row-order", score: rows.map((r) => r.slug).join() === key.expected.map((e) => e.slug).join() ? 1 : 0 },
    { id: "updated-cells", score: correct / (key.expected.length * 3) },
    { id: "untouched-cells", score: rows.length > 0 ? untouched / (key.expected.length * 2) : 0 },
  ];
}
