import { type BenchTask, type Fixture, defineTask } from "../../core/types.ts";
import { type CrisisKey, generate } from "./generate.ts";
import { verify } from "./verify.ts";

export function task(): BenchTask {
  return defineTask<CrisisKey>({
    id: "founder-crisis-brief",
    difficulty: "easy",
    family: "founder-support",
    origin: "research",
    evidence:
      "Garry Tan's Own Your Intelligence talk (14:48): contextual founder-crisis help drawing on prior conversations and relevant precedents.",
    sources: ["https://www.youtube.com/watch?v=eRrc1pUY5oU&t=888s"],
    outputs: ["output/brief.json"],
    generate,
    prompt: (f) =>
      `${f.key.founder} from ${f.key.company} wrote in; the whole exchange is in inbox/thread.md. Write a crisis brief for the partner on call as JSON at output/brief.json with keys: ` +
      "issues (array of canonical situation types from precedents/INDEX.md), runway_months (number, the founder's current figure), latest_mrr (number, from our most recent check-in note by the Date inside the note), " +
      "precedents (array of precedent file names without .md whose situation matches one of the founder's issues), sources (array of file paths you relied on), next_steps (array of strings), conflicts (array of file paths, normally empty). " +
      "Check-in note file names carry no meaning. If two check-in notes carry the same most recent Date and disagree on MRR, do not pick one: set latest_mrr to null and put both paths in conflicts. Ground every number in a file you read.",
    verify,
  });
}

export function gold(f: Fixture<CrisisKey>): Record<string, string> {
  const k = f.key;
  return {
    "output/brief.json": JSON.stringify({
      issues: k.issues,
      runway_months: k.numbers.runwayMonths,
      latest_mrr: k.conflictPath === null ? k.latestMrr : null,
      conflicts: k.conflictPath === null ? [] : [k.latestNotePath, k.conflictPath],
      precedents: k.precedents,
      sources: [
        "inbox/thread.md",
        k.latestNotePath,
        "precedents/INDEX.md",
        ...k.precedents.map((p) => `precedents/${p}.md`),
      ],
      next_steps: [
        "Call the founder tomorrow",
        "Separate the problems and assign an owner to each",
        "Open a bridge conversation with seed investors",
      ],
    }),
  };
}
