import { execFileSync } from "node:child_process";
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

const lensHeadings = (spec: string) =>
  (section(lines(spec), "## Wall of shame") ?? []).filter((line) => line.startsWith("### "));

const lensName = (heading: string) => heading.slice(4).split(" (")[0]!.trim();

const lensesMarked = (spec: string, mark: string) =>
  lensHeadings(spec)
    .filter((heading) => heading.includes(mark))
    .map(lensName);

export function wallOfShameLenses(spec: string) {
  return lensHeadings(spec).map(lensName);
}

const lockfiles = ["package-lock.json", "Cargo.lock", "Package.resolved"];

function overTesting(numstat: string) {
  let tests = 0;
  let source = 0;
  const fields = numstat.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const [added, removed, ...path] = fields[i]!.split("\t");
    if (removed === undefined) continue;
    const dirs = (path.join("\t") || fields[(i += 2)]!).split("/");
    const name = dirs.pop()!;
    if (name.includes(".test.") || dirs.some((dir) => dir === "test" || dir === "tests" || dir.endsWith("Tests")))
      tests += (Number(added) || 0) - (Number(removed) || 0);
    else if (!name.endsWith(".md") && !lockfiles.includes(name)) source += Number(added) || 0;
  }
  if (tests > source)
    return `net test lines added (${tests}) exceed source lines added (${source}). Remove or reshape tests until they do not.`;
}

const computedLenses = new Map([["Over-testing", overTesting]]);

export function wallOfShameProblems(spec: string, body: string, headSha: string, numstat: string) {
  const report = section(lines(body), "## Wall of shame review report");
  const problems = report ? [] : ["PR description has no `## Wall of shame review report` section."];
  const reviewed = report?.find((line) => line.startsWith("Reviewed commit:"))?.split("`")[1];
  if (report && reviewed !== headSha)
    problems.push(`Reviewed commit is ${reviewed ?? "missing"}, but the PR head is ${headSha}.`);
  const rows = (report ?? [])
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.replaceAll("*", "").trim()),
    );
  const always = lensesMarked(spec, "(always reviewed");
  const computed = lensesMarked(spec, "(checked by CI");
  for (const lens of wallOfShameLenses(spec)) {
    const matches = rows.filter((cells) => cells[0] === lens);
    if (matches.length > 1) problems.push(`${lens}: ${matches.length} review rows; keep one.`);
    const [, reviewer, verdict, score, assessment] = matches[0] ?? [];
    const skipped = verdict?.toLowerCase() === "not relevant";
    const waived = verdict?.toLowerCase() === "waived";
    if (waived) {
      const [who, what] = assessment?.startsWith("Waived by ") ? assessment.slice(10).split(":") : [];
      if (!who?.trim() || !what?.trim())
        problems.push(`${lens}: a Waived row's assessment must read "Waived by <name>: <what was waived>".`);
    }
    if (computed.includes(lens)) {
      const check = computedLenses.get(lens);
      const finding = check ? !waived && check(numstat) : "marked checked by CI, but this check does not compute it.";
      if (finding) problems.push(`${lens}: ${finding}`);
      continue;
    }
    if (!report) continue;
    if (!verdict) problems.push(`${lens}: no review row.`);
    else if (skipped && always.includes(lens))
      problems.push(`${lens}: always reviewed; triage cannot mark it Not relevant.`);
    else if (!skipped && !waived && verdict.toLowerCase() !== "accept")
      problems.push(`${lens}: verdict is ${verdict}, not Accept, Waived or Not relevant.`);
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
    execFileSync("git", ["diff", "--numstat", "-z", "-M", `origin/${process.env.GITHUB_BASE_REF || "main"}...HEAD`], {
      encoding: "utf8",
    }),
  );
  if (problems.length) {
    console.error("Wall of shame review incomplete (see AGENTS.md):");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log("Wall of shame review: every lens passed for the PR head, was waived, or was triaged as not relevant.");
}
