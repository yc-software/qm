import { csv } from "../../core/text.ts";
import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type CompanyRow, type UpdateKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<UpdateKey>({
    id: "portfolio-update-records",
    difficulty: "hard",
    family: "portfolio",
    origin: "observed",
    evidence:
      "Proposed portfolio workflow for qm: keep the company records current from inbound founder updates. Not a workflow Garry listed.",
    sources: ["https://qm.ycombinator.com/", "https://github.com/yc-software/qm"],
    outputs: ["output/companies.csv"],
    generate,
    prompt: () =>
      "Founder updates arrived in updates/ as email threads; read updates/README.md first. Apply them to portfolio/companies.csv and write the result to output/companies.csv with the same columns and row order. " +
      "Update mrr_usd and headcount only where the founder's final word in a thread states a new value; set last_update to the date of that final message; when a company has two threads the newer wins. Senders whose domain is not in portfolio/domains.csv are not portfolio companies. Leave every other cell exactly as it was. Write a script.",
    verify,
  });
}

export function gold(f: Fixture<UpdateKey>): Record<string, string> {
  return {
    "output/companies.csv": csv(
      f.key.header,
      f.key.expected.map((c) => f.key.header.map((h) => c[h as keyof CompanyRow])),
    ),
  };
}
