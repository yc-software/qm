import { asArray, asRecord, parseJson, str } from "../../core/text.ts";
import type { Check, Outputs } from "../../core/types.ts";
import type { CommitmentsKey } from "./generate.ts";

function matched(
  expected: Array<{ owner: string; task: string; due: string }>,
  rows: Record<string, unknown>[],
): number {
  const free = new Set(rows);
  let hits = 0;
  for (const c of expected) {
    const suffix = c.task.split(" ").slice(-2).join(" ");
    const row = [...free].find(
      (g) =>
        str(g.owner).toLowerCase() === c.owner.toLowerCase() &&
        str(g.due) === c.due &&
        str(g.task).toLowerCase().includes(suffix),
    );
    if (!row) continue;
    free.delete(row);
    hits++;
  }
  return expected.length === 0 ? 1 : hits / expected.length;
}

export async function verify(outputs: Outputs, key: CommitmentsKey): Promise<Check[]> {
  const rows = asArray(parseJson(await outputs.read("output/commitments.json"))).map(asRecord);
  const openRows = asArray(parseJson(await outputs.read("output/open.json"))).map(asRecord);
  const overdueRight =
    key.open.filter((c) =>
      openRows.some(
        (g) => str(g.due) === c.due && str(g.owner).toLowerCase() === c.owner.toLowerCase() && g.overdue === c.overdue,
      ),
    ).length / key.open.length;
  return [
    { id: "commitments-after-corrections", score: matched(key.afterCorrections, rows) },
    { id: "open-set", score: matched(key.open, openRows) },
    { id: "overdue-flags", score: openRows.length === 0 ? 0 : overdueRight },
    {
      id: "counts",
      score: rows.length === key.afterCorrections.length && openRows.length === key.open.length ? 1 : 0,
    },
  ];
}
