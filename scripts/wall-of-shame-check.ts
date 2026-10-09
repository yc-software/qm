import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TRIAGE_MODEL = "claude-haiku-5-5";
const DIFF_CHARS = 60_000;

const section = (lines: string[], heading: string) => {
  const start = lines.indexOf(heading);
  if (start < 0) return undefined;
  const level = `${heading.split(" ")[0]} `;
  const end = lines.findIndex((line, i) => i > start && line.startsWith(level));
  return lines.slice(start + 1, end < 0 ? undefined : end);
};

const lines = (text: string) => text.replaceAll("\r\n", "\n").split("\n");
const lensName = (heading: string) => heading.slice(4).split(" (")[0]!.trim();

export function wallOfShameLenses(spec: string) {
  return (section(lines(spec), "## Wall of shame") ?? []).filter((line) => line.startsWith("### ")).map(lensName);
}

export function wallOfShameLensText(spec: string) {
  const wall = section(lines(spec), "## Wall of shame") ?? [];
  return Object.fromEntries(
    wall
      .filter((line) => line.startsWith("### "))
      .map((heading) => [lensName(heading), (section(wall, heading) ?? []).join("\n").trim()]),
  );
}

export function triagePrompt(spec: string, diff: string) {
  const lenses = Object.entries(wallOfShameLensText(spec))
    .map(([name, text]) => `<lens name="${name}">\n${text}\n</lens>`)
    .join("\n\n");
  return `You triage pull requests for review. Each lens below describes a class of mistake. A lens is relevant when the diff touches code, docs, config, or behavior where that mistake could plausibly occur. When unsure, mark it relevant.

${lenses}

<diff>
${diff}
</diff>

Reply with only JSON: {"relevant": ["<lens name>", ...]}`;
}

export function parseTriage(text: string, lenses: string[]) {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const relevant: unknown = JSON.parse(json).relevant;
  if (!Array.isArray(relevant)) throw new Error(`triage reply has no relevant array: ${text}`);
  return lenses.filter((lens) => relevant.includes(lens));
}

export async function relevantLenses(spec: string, diff: string, apiKey: string) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: TRIAGE_MODEL,
      max_tokens: 500,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: triagePrompt(spec, diff) }],
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`triage request failed with HTTP ${response.status}: ${body}`);
  const content = (JSON.parse(body) as { content: { type: string; text?: string }[] }).content;
  return parseTriage(content.find((block) => block.type === "text")?.text ?? body, wallOfShameLenses(spec));
}

export function wallOfShameProblems(spec: string, body: string, headSha: string, required = wallOfShameLenses(spec)) {
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
  for (const lens of required) {
    const matches = rows.filter((cells) => cells[0] === lens);
    if (matches.length > 1) problems.push(`${lens}: ${matches.length} review rows; keep one.`);
    const [, reviewer, verdict, score, assessment] = matches[0] ?? [];
    if (!verdict) problems.push(`${lens}: no review row.`);
    else if (verdict.toLowerCase() !== "accept") problems.push(`${lens}: verdict is ${verdict}, not Accept.`);
    if (verdict && !reviewer) problems.push(`${lens}: reviewer missing.`);
    if (verdict && !/^(100|\d{1,2})\/100$/.test(score ?? "")) problems.push(`${lens}: score missing (expected N/100).`);
    if (verdict && !assessment) problems.push(`${lens}: assessment missing.`);
  }
  return problems;
}

async function required(spec: string) {
  const all = wallOfShameLenses(spec);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("No ANTHROPIC_API_KEY; every lens is required.");
    return all;
  }
  const diff = execFileSync("git", ["diff", process.env.BASE_SHA || "origin/main", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  try {
    const relevant = await relevantLenses(spec, diff.slice(0, DIFF_CHARS), apiKey);
    console.log(`Relevant lenses: ${relevant.join(", ") || "none"}`);
    console.log(`Skipped lenses: ${all.filter((lens) => !relevant.includes(lens)).join(", ") || "none"}`);
    return relevant;
  } catch (error) {
    console.log(`Triage failed; every lens is required. ${error instanceof Error ? error.stack : String(error)}`);
    return all;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const spec = readFileSync("docs/SPEC.md", "utf8");
  const lenses = await required(spec);
  if (process.argv.includes("--triage")) process.exit(0);
  const problems = wallOfShameProblems(spec, process.env.PR_BODY ?? "", process.env.HEAD_SHA ?? "", lenses);
  if (problems.length) {
    console.error("Wall of shame review incomplete (see AGENTS.md):");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log("Wall of shame review: every relevant lens accepted the PR head.");
}
