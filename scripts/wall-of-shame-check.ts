import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const section = (lines: string[], heading: string) => {
  const start = lines.indexOf(heading);
  if (start < 0) return undefined;
  const level = `${heading.split(" ")[0]} `;
  const end = lines.findIndex((line, i) => i > start && line.startsWith(level));
  return lines.slice(start + 1, end < 0 ? undefined : end);
};

const lines = (text: string) => text.replaceAll("\r\n", "\n").split("\n");

export function wallOfShameLenses(spec: string) {
  return (section(lines(spec), "## Wall of shame") ?? [])
    .filter((line) => line.startsWith("### "))
    .map((line) => line.slice(4).split(" (")[0]!.trim());
}

export function wallOfShameProblems(spec: string, body: string, headSha: string) {
  const report = section(lines(body), "## Wall of shame review report");
  if (!report) return ["PR description has no `## Wall of shame review report` section."];
  const problems: string[] = [];
  const reviewed = report.find((line) => line.startsWith("Reviewed commit:"))?.split("`")[1];
  if (reviewed !== headSha)
    problems.push(`Reviewed commit is ${reviewed ?? "missing"}, but the PR head is ${headSha}.`);
  const rows = report
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.replaceAll("*", "").trim()),
    );
  for (const lens of wallOfShameLenses(spec)) {
    const matches = rows.filter((cells) => cells[0] === lens);
    if (matches.length > 1) problems.push(`${lens}: ${matches.length} review rows; keep one.`);
    const [, reviewer, verdict, score, assessment] = matches[0] ?? [];
    const skipped = verdict?.toLowerCase() === "not relevant";
    if (!verdict) problems.push(`${lens}: no review row.`);
    else if (!skipped && verdict.toLowerCase() !== "accept")
      problems.push(`${lens}: verdict is ${verdict}, not Accept or Not relevant.`);
    if (verdict && !reviewer) problems.push(`${lens}: reviewer missing.`);
    if (verdict && !skipped && !/^(100|\d{1,2})\/100$/.test(score ?? ""))
      problems.push(`${lens}: score missing (expected N/100).`);
    if (verdict && !assessment) problems.push(`${lens}: assessment missing.`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = wallOfShameProblems(
    readFileSync("docs/SPEC.md", "utf8"),
    process.env.PR_BODY ?? "",
    process.env.HEAD_SHA ?? "",
  );
  if (problems.length) {
    console.error("Wall of shame review incomplete (see AGENTS.md):");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log("Wall of shame review: every lens accepted the PR head or was triaged as not relevant.");
}
