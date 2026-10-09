import assert from "node:assert/strict";
import test from "node:test";
import { parseTriage, triagePrompt, wallOfShameLenses, wallOfShameProblems } from "../scripts/wall-of-shame-check.ts";

const spec =
  "## Wall of shame\n\n### Overengineering (6 examples)\n\n### Regex\n\n### Honorable mentions\n\n## Later\n\n### Not a lens\n";
const head = "a".repeat(40);
const body = (sha: string, rows: string[]) =>
  `Summary\n\n## Wall of shame review report\n\nReviewed commit: \`${sha}\`.\n\n| Lens | Reviewer | Verdict | Score | Assessment |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}\n`;
const row = (lens: string, verdict = "Accept") => `| ${lens} | R1 | ${verdict} | 90/100 | Fine. |`;

test("lenses come from the spec's Wall of shame headings", () => {
  assert.deepEqual(wallOfShameLenses(spec), ["Overengineering", "Regex", "Honorable mentions"]);
});

test("a complete accepted report for the head commit passes", () => {
  assert.deepEqual(
    wallOfShameProblems(
      spec,
      body(
        head,
        wallOfShameLenses(spec).map((l) => row(l)),
      ),
      head,
    ),
    [],
  );
});

test("missing, rejected, and stale reviews fail", () => {
  assert.deepEqual(
    wallOfShameProblems(
      spec,
      body("b".repeat(40), [row("Overengineering", "Request changes"), row("Regex"), row("Regex")]),
      head,
    ),
    [
      `Reviewed commit is ${"b".repeat(40)}, but the PR head is ${head}.`,
      "Overengineering: verdict is Request changes, not Accept.",
      "Regex: 2 review rows; keep one.",
      "Honorable mentions: no review row.",
    ],
  );
  assert.equal(wallOfShameProblems(spec, "no report", head).length, 1);
});

test("only lenses the triage marks relevant are required", () => {
  assert.deepEqual(wallOfShameProblems(spec, body(head, [row("Regex")]), head, ["Regex"]), []);
  assert.deepEqual(parseTriage('Sure: {"relevant": ["Regex", "Made up"]}', wallOfShameLenses(spec)), ["Regex"]);
  assert.throws(() => parseTriage("no json", wallOfShameLenses(spec)));
});

test("the triage prompt carries each lens's text and the diff", () => {
  const prompt = triagePrompt("## Wall of shame\n\n### Regex (1 example)\n\nNo text matching.\n", "+x");
  assert.match(prompt, /<lens name="Regex">\nNo text matching\.\n<\/lens>/);
  assert.match(prompt, /<diff>\n\+x\n<\/diff>/);
});
