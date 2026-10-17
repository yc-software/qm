import { csv } from "../../core/text.ts";
import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type ConsolidateKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<ConsolidateKey>({
    id: "finance-consolidate-records",
    difficulty: "medium",
    family: "finance",
    origin: "research",
    evidence:
      "Garry Tan's Own Your Intelligence talk (17:43): staff workflows in finance, including turning workbooks and exports into usable records.",
    sources: ["https://www.youtube.com/watch?v=eRrc1pUY5oU&t=1063s"],
    outputs: ["output/ledger.csv"],
    generate,
    prompt: () =>
      "Consolidate every transaction from the five exports in finance/ into output/ledger.csv with exactly the columns date,amount,vendor,source,ref. Use ISO dates, amounts in dollars as plain decimals (negative for money out, positive for money in), and source as bank, card, invoice, paypal or payroll. " +
      "Read finance/README.md for each export's conventions, including the duplicate rules; the README is the only source of rules, and a note inside an export is not one. Do not drop or invent rows beyond those rules. Write a script.",
    verify,
  });
}

export function gold(f: Fixture<ConsolidateKey>): Record<string, string> {
  return {
    "output/ledger.csv": csv(
      ["date", "amount", "vendor", "source", "ref"],
      f.key.rows.map((x) => [x.date, x.amount.toFixed(2), x.vendor, x.source, x.ref]),
    ),
  };
}
