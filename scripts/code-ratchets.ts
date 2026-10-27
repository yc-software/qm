import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { comments, isProduction } from "./strip-comments.ts";

const EXEMPT = [
  ":!*.md",
  ":!test/",
  ":!**/test/**",
  ":!*.test.*",
  ":!**/vendor/**",
  ":!docs/",
  ":!adrs/",
  ":!*.json",
  ":!scripts/code-ratchets.ts",
];
export const NAME_RULES = [
  { label: "legacy identifier", grep: ["-i", "-e", "legacy"], match: /[\w$-]*legacy[\w$-]*/gi },
  { label: "*_MODE env name", grep: ["-e", "_MODE"], match: /\b[A-Z][A-Z0-9_]*_MODE\b/g },
  {
    label: "key-value store helper",
    grep: ["-i", "-e", "map", "-e", "kv", "-e", "keyvalue"],
    match: /\b\w*(?:DurableMap|durableMap|[Kk]vStore|[Kk]eyValue|createMap|artifactMap|testMap)\w*/g,
  },
  {
    label: "flag env name",
    grep: ["-e", "ENABLE"],
    match: /\b(?:[A-Z][A-Z0-9_]*_ENABLED|ENABLE_[A-Z0-9_]+|DISABLE_[A-Z0-9_]+)\b/g,
  },
];

const git = (...args: string[]) => {
  const run = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (run.status !== 0 && !(args[0] === "grep" && run.status === 1)) throw new Error(`git ${args[0]}: ${run.stderr}`);
  return run.stdout;
};

export function blobTables(source: string, path: string) {
  const found = new Set<string>();
  for (const create of source.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."${}]+)\s*\(/gi)) {
    const parts = [""];
    let depth = 1;
    for (const ch of source.slice(create.index + create[0].length)) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (!depth) break;
      if (ch === "," && depth === 1) parts.push("");
      else parts[parts.length - 1] += ch;
    }
    const columns = parts
      .map((part) => part.trim().replaceAll('"', "").split(/\s+/))
      .filter(([name]) => !/^(primary|unique|constraint|foreign|check|exclude|tenant_id|\w+_at)$/i.test(name!));
    if (columns.length === 2 && columns.filter(([, type]) => /^jsonb?$/i.test(type ?? "")).length === 1)
      found.add(create[1]!.includes("${") ? `${path}:${create[1]}` : create[1]!.replaceAll('"', "").toLowerCase());
  }
  return found;
}

export const names = (text: string, rule: (typeof NAME_RULES)[number]) =>
  new Set([...text.matchAll(rule.match)].map((m) => m[0]));

export const featureFlags = (source: string) =>
  new Set(
    [...(source.split("export const FEATURES = {")[1]?.split("\n} as const")[0] ?? "").matchAll(/^ {2}(\w+):/gm)].map(
      (m) => m[1]!,
    ),
  );

function newNames(base: string) {
  const added = (label: string, before: Set<string>, after: Set<string>) =>
    [...after].filter((n) => !before.has(n)).map((n) => `New ${label}: ${n}`);
  const flags = (rev: string) => featureFlags(git("show", `${rev}:src/feature-flags.ts`));
  const tables = (rev: string) =>
    new Set(
      git("grep", "-ilI", "create table", rev, "--", "*.sql", "*.ts", "*.mjs", ...EXEMPT)
        .split("\n")
        .filter(Boolean)
        .flatMap((file) => [...blobTables(git("show", file), file.slice(rev.length + 1))]),
    );
  return [
    ...NAME_RULES.flatMap((rule) => {
      const at = (rev: string) => names(git("grep", "-hI", ...rule.grep, rev, "--", ".", ...EXEMPT), rule);
      return added(rule.label, at(base), at("HEAD"));
    }),
    ...added("feature flag", flags(base), flags("HEAD")),
    ...added("JSON blob table", tables(base), tables("HEAD")),
  ];
}

function newComments(base: string) {
  const count = (rev: string, path: string) => {
    const show = spawnSync("git", ["show", `${rev}:${path}`], { encoding: "utf8", maxBuffer: 1 << 28 });
    return show.status === 0 ? comments(path, show.stdout).length : 0;
  };
  return git("diff", "--name-only", "--diff-filter=d", `${base}...HEAD`)
    .split("\n")
    .filter(isProduction)
    .flatMap((path) => {
      const added = count("HEAD", path) - count(base, path);
      return added > 0 ? [`${path} adds ${added} comment${added === 1 ? "" : "s"}; production code has none.`] : [];
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { base: { type: "string" } }, strict: true });
  if (!values.base) throw new Error("Pass --base <ref>.");
  const problems = [...newNames(values.base), ...newComments(values.base)];
  for (const problem of problems) console.error(problem);
  console.log(`${problems.length} ratchet problems against ${values.base}.`);
  if (problems.length) process.exit(1);
}
