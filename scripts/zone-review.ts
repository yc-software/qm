import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { mapBounded } from "../src/util/async.ts";
import { lines, section } from "./wall-of-shame-check.ts";

const MODEL = "gateway/openai/gpt-6.1-sol";
const CHUNK_LINES = 1500;

export interface Source {
  path: string;
  text: string;
  anchorable: Array<{ line: number; text: string }>;
}

export interface Finding {
  path: string;
  line: number;
  lens: string;
  severity: string;
  title: string;
  anchor: string;
}

const readZone = () => lines(readFileSync("slop-free-zone.txt", "utf8")).filter(Boolean);

export const inZone = (zone: string[], path: string) => zone.some((z) => path === z || path.startsWith(`${z}/`));

export const isReviewable = (path: string) =>
  /\.(ts|tsx|mts|js|mjs|cjs|css|html|sh)$/.test(path) && !/(^|\/)test\/|\.test\./.test(path);

export const fileSource = (path: string, text: string): Source => ({
  path,
  text,
  anchorable: lines(text).map((t, i) => ({ line: i + 1, text: t })),
});

export function diffSource(path: string, diff: string): Source {
  const anchorable: Source["anchorable"] = [];
  let next = 0;
  for (const row of lines(diff)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) next = Number(hunk[1]);
    else if (row.startsWith("+") && !row.startsWith("+++")) anchorable.push({ line: next++, text: row.slice(1) });
    else if (row.startsWith(" ")) next++;
  }
  return { path, text: diff, anchorable };
}

export function chunks(sources: Source[]): Source[][] {
  const out: Source[][] = [];
  let size = Infinity;
  for (const source of sources) {
    const length = lines(source.text).length;
    if (size + length > CHUNK_LINES) {
      out.push([]);
      size = 0;
    }
    out.at(-1)!.push(source);
    size += length;
  }
  return out;
}

export function verifiedFindings(reply: string, sources: Source[]) {
  const parsed = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)) as {
    findings: Array<Omit<Finding, "line">>;
  };
  const findings = parsed.findings.flatMap(({ path, lens, severity, title, anchor }): Finding[] => {
    const cited = (anchor ?? "").trim();
    const hit = sources.find((s) => s.path === path)?.anchorable.find((a) => cited && a.text.includes(cited));
    return hit
      ? [{ path, line: hit.line, lens: (lens ?? "").replace(/\s*\(.*\)$/, ""), severity, title, anchor: cited }]
      : [];
  });
  return { findings, unverified: parsed.findings.length - findings.length };
}

const REVIEWER_PROMPT = [
  "You review code against the Wall of shame below: this repository's catalog of code smells. Each ### heading is a lens.",
  "Report every place where the code shown clearly matches a lens. Lenses about process (QA, testing, history) count only when the code itself shows the problem. Skip doubtful cases: report only what a senior reviewer would ask to change.",
  'Reply with JSON only: {"findings":[{"lens":"<lens heading without its example count>","severity":"high|medium|low","path":"<file path as shown>","anchor":"<one line copied verbatim from the code, the line the finding cites>","title":"<one sentence>"}]}. Reply {"findings":[]} when nothing qualifies.',
].join("\n");

const DIFF_NOTE =
  "Review only what these diffs add. Each anchor must be a line the diff adds (a + line, copied without the +).";

async function complete(system: string, user: string) {
  if (!process.env.MODEL_GATEWAY_URL || !process.env.MODEL_GATEWAY_TOKEN)
    throw new Error("Set MODEL_GATEWAY_URL and MODEL_GATEWAY_TOKEN; QM provides both in its sandboxes.");
  const res = await fetch(`${process.env.MODEL_GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.MODEL_GATEWAY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "medium",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const raw = await res.text();
  const body = (res.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : { error: raw }) as {
    choices?: Array<{ finish_reason: string; message: { content: string } }>;
    error?: unknown;
  };
  const choice = body.choices?.[0];
  if (!res.ok || choice?.finish_reason !== "stop")
    throw new Error(
      `Zone review call failed (HTTP ${res.status}): ${JSON.stringify(body.error ?? choice?.finish_reason)}`,
    );
  return choice.message.content;
}

async function main() {
  const { values } = parseArgs({ options: { base: { type: "string" } } });
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  const zone = readZone();
  const base = values.base;
  const files = (base ? git("diff", "--name-only", "--diff-filter=d", `${base}...HEAD`) : git("ls-files", ...zone))
    .split("\n")
    .filter(isReviewable);
  const zoneFiles = files.filter((p) => inZone(zone, p)).map((p) => fileSource(p, readFileSync(p, "utf8")));
  const outside = base
    ? files.filter((p) => !inZone(zone, p)).map((p) => diffSource(p, git("diff", "-U30", `${base}...HEAD`, "--", p)))
    : [];
  console.error(`Reviewing ${zoneFiles.length} zone files and ${outside.length} changed files outside the zone.`);
  const spec = section(lines(readFileSync("docs/SPEC.md", "utf8")), "## Wall of shame") ?? [];
  const system = [REVIEWER_PROMPT, "", ...spec].join("\n");
  const jobs = [
    ...chunks(zoneFiles).map((chunk) => ({ chunk, note: "Review these files in full." })),
    ...chunks(outside).map((chunk) => ({ chunk, note: DIFF_NOTE })),
  ];
  const results = await mapBounded(jobs, 8, async ({ chunk, note }) =>
    verifiedFindings(
      await complete(system, [note, ...chunk.map((s) => `=== ${s.path} ===\n${s.text}`)].join("\n\n")),
      chunk,
    ),
  );
  const findings = results.flatMap((r) => r.findings);
  const dropped = results.reduce((n, r) => n + r.unverified, 0);
  console.log(JSON.stringify({ count: findings.length, dropped, findings }, null, 2));
  if (findings.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
