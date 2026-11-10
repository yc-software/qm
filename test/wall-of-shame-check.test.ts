import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { wallOfShameLenses, wallOfShameProblems } from "../scripts/wall-of-shame-check.ts";

const spec =
  "## Wall of shame\n\n### Overengineering (6 examples)\n\n### Regex\n\n### Over-testing (checked by CI)\n\n### Honorable mentions\n\n## Later\n\n### Not a lens\n";
const head = "a".repeat(40);
const body = (sha: string, rows: string[]) =>
  `Summary\n\n## Wall of shame review report\n\nReviewed commit: \`${sha}\`.\n\n| Lens | Reviewer | Verdict | Score | Assessment |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
const row = (lens: string, verdict = "Accept", assessment = "Fine.") =>
  `| ${lens} | R1 | ${verdict} | 90/100 | ${assessment} |`;
const reviewed = ["Overengineering", "Regex", "Honorable mentions"];
const problems = (description: string, numstat = "", against = spec) =>
  wallOfShameProblems(against, description, head, numstat);
const overTested = (tests: number, source: number) =>
  `Over-testing: net test lines added (${tests}) exceed source lines added (${source}). Remove or reshape tests until they do not.`;

test("lenses come from the spec's Wall of shame headings", () => {
  assert.deepEqual(wallOfShameLenses(spec), ["Overengineering", "Regex", "Over-testing", "Honorable mentions"]);
});

test("a complete accepted report for the head commit passes", () => {
  assert.deepEqual(
    problems(
      body(
        head,
        reviewed.map((lens) => row(lens)),
      ),
    ),
    [],
  );
});

test("missing, rejected, and stale reviews fail", () => {
  assert.deepEqual(
    problems(body("b".repeat(40), [row("Overengineering", "Request changes"), row("Regex"), row("Regex")])),
    [
      `Reviewed commit is ${"b".repeat(40)}, but the PR head is ${head}.`,
      "Overengineering: verdict is Request changes, not Accept, Waived or Not relevant.",
      "Regex: 2 review rows; keep one.",
      "Honorable mentions: no review row.",
    ],
  );
  assert.equal(problems("no report").length, 1);
});

test("lenses triaged as not relevant need a reviewer and reason but no score", () => {
  const skip = (lens: string) => `| ${lens} | Haiku triage | Not relevant |  | No regex in the diff. |`;
  assert.deepEqual(problems(body(head, [row("Overengineering"), skip("Regex"), skip("Honorable mentions")])), []);
  assert.deepEqual(
    problems(body(head, [row("Overengineering"), "| Regex |  | Not relevant |  |  |", row("Honorable mentions")])),
    ["Regex: reviewer missing.", "Regex: assessment missing."],
  );
});

test("always-reviewed lenses cannot be triaged as not relevant", () => {
  const strict = spec.replace("### Overengineering (6 examples)", "### Overengineering (always reviewed, 6 examples)");
  const skip = (lens: string) => `| ${lens} | Haiku triage | Not relevant |  | Small diff. |`;
  assert.deepEqual(problems(body(head, reviewed.map(skip)), "", strict), [
    "Overengineering: always reviewed; triage cannot mark it Not relevant.",
  ]);
});

test("a waived lens passes only when the row names who waived it and what", () => {
  const rest = [row("Regex"), row("Honorable mentions")];
  const waived = (assessment: string) => body(head, [row("Overengineering", "Waived", assessment), ...rest]);
  const malformed = 'Overengineering: a Waived row\'s assessment must read "Waived by <name>: <what was waived>".';
  assert.deepEqual(problems(waived("Waived by Regan: the reviewer asked for a smaller helper.")), []);
  assert.deepEqual(problems(waived("Ships as is.")), [malformed]);
  assert.deepEqual(problems(waived("Waived by : no name.")), [malformed]);
  assert.deepEqual(problems(waived("Waived by Regan")), [malformed]);
});

test("over-testing is counted from the diff, whatever the report says", () => {
  const accepted = body(
    head,
    [...reviewed, "Over-testing"].map((lens) => row(lens)),
  );
  const diff = (...entries: string[]) => [...entries, ""].join("\0");
  const source = [
    "10\t4\tsrc/a.ts",
    "500\t0\tplugins/web-ui/package-lock.json",
    "300\t0\tdocs/notes.md",
    "-\t-\tdocs/logo.png",
  ];
  const moved = ["2\t0\t", "test/old.test.ts", "plugins/web-ui/test/new.test.ts"];
  assert.deepEqual(problems(accepted, diff(...source, "9\t0\ttest/a.test.ts", ...moved)), [overTested(11, 10)]);
  assert.deepEqual(problems(accepted, diff(...source, "8\t0\tios/QMTests/A.swift", ...moved)), []);
  assert.deepEqual(problems(accepted, diff(...source, "30\t20\ttest/a.test.ts")), []);
  assert.deepEqual(problems("no report", diff("1\t0\ttest/a.test.ts")), [
    "PR description has no `## Wall of shame review report` section.",
    overTested(1, 0),
  ]);
  const waiver = row("Over-testing", "Waived", "Waived by Regan: a regression suite for an untested module.");
  assert.deepEqual(
    problems(body(head, [...reviewed.map((lens) => row(lens)), waiver]), diff("9\t0\ttest/a.test.ts")),
    [],
  );
  const mismarked = spec.replace("### Regex", "### Regex (checked by CI)");
  assert.deepEqual(problems(accepted, "", mismarked), [
    "Regex: marked checked by CI, but this check does not compute it.",
  ]);
  const unmarked = spec.replace(" (checked by CI)", "");
  assert.deepEqual(
    problems(
      body(
        head,
        reviewed.map((lens) => row(lens)),
      ),
      diff("9\t0\ttest/a.test.ts"),
      unmarked,
    ),
    ["Over-testing: no review row."],
  );
});

test("the spec always reviews Historylessness and counts Over-testing", () => {
  const real = readFileSync("docs/SPEC.md", "utf8");
  const rows = wallOfShameLenses(real)
    .filter((lens) => lens !== "Over-testing")
    .map((lens) =>
      lens === "Historylessness" ? `| ${lens} | Haiku triage | Not relevant |  | No schema change. |` : row(lens),
    );
  assert.deepEqual(problems(body(head, rows), "1\t0\ttest/a.test.ts", real), [
    "Historylessness: always reviewed; triage cannot mark it Not relevant.",
    overTested(1, 0),
  ]);
});
