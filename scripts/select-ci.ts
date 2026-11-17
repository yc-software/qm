import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

const RUN_ALL = [
  /^test\/support\/test-template\.ts$/,
  /^package(-lock)?\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^\.(npmrc|node-version)$/,
  /^\.github\//,
  /^vendor\//,
  /^scripts\/(run-pg-tests\.mjs|run-root-test-shard\.mjs|select-ci\.ts)$/,
];
const RUNNERS = ["test/support/boot-tenant-entry.ts", "test/support/test-tenant.ts"];
const WEB_UI = /^(plugins\/web-ui\/|deploy\/core\/|scripts\/smoke-core-image\.sh$|\.dockerignore$)/;
const CLI = /^(cli|deploy\/stacks)\//;
const ROOT_PACKAGE = /^(src|test|scripts)\//;
const MODULE = /\.(?:[cm]?[jt]s|tsx)$/;
const CORE_TEST = /^test\/[^/]+\.test\.ts$/;
const STATEMENT =
  /(?<![\w$.])(?:(import|export)(\s+type(?=[\s{*]))?\s+[^"'`;]*?\sfrom\s*|(typeof\s+)?import\s*\(\s*|import\s+)(["'])([^"'\n]+)\4/g;
const TYPE_POSITION = /^\s*\)\s*\.(?!then\b|catch\b|finally\b)\w/;
const TOKEN = /[\w@.-]*\/[\w@./-]+|[\w@-][\w@.-]*\.[A-Za-z]{1,5}\b/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.js"];

type Selection = { core: string[] | "all"; webUi: boolean; cli: boolean };
const ALL: Selection = { core: "all", webUi: true, cli: true };

function references(path: string, source: string, files: Set<string>, dirs: Set<string>) {
  const here = posix.dirname(path);
  const found = { files: new Set<string>(), dirs: new Set<string>() };
  const add = (target: string, candidates: string[]) => {
    const file = candidates.map((candidate) => posix.normalize(candidate)).find((candidate) => files.has(candidate));
    const dir = posix.normalize(target).replace(/\/$/, "");
    if (file && !RUN_ALL.some((rule) => rule.test(file))) found.files.add(file);
    else if (!file && dirs.has(dir)) found.dirs.add(dir);
  };
  const rest = source.replace(STATEMENT, (match, kind, type, typeOf, _quote, specifier: string, at: number) => {
    const target = posix.join(here, specifier);
    const after = source.slice(at + match.length, at + match.length + 40);
    const typeOnly = kind ? type : typeOf || TYPE_POSITION.test(after);
    if (!typeOnly && specifier.startsWith(".")) {
      add(target, [...EXTENSIONS.map((extension) => target + extension), target.replace(/\.js$/, ".ts")]);
    }
    return "";
  });
  if (!ROOT_PACKAGE.test(path)) return found;
  for (const token of rest.match(TOKEN) ?? []) {
    if (/^[./]*$/.test(token)) continue;
    add(posix.join(here, token), [posix.join(here, token)]);
    if (!token.startsWith(".")) add(token.replace(/^\/+/, ""), [token.replace(/^\/+/, "")]);
  }
  return found;
}

export function select(changed: string[], tracked: string[], read: (path: string) => string): Selection {
  if (changed.length === 0) return { core: [], webUi: false, cli: false };
  if (changed.some((path) => RUN_ALL.some((rule) => rule.test(path)))) return ALL;
  if (changed.some((path) => path.startsWith("src/") && !MODULE.test(path))) return ALL;
  const files = new Set(tracked);
  const dirs = new Set(tracked.flatMap((path) => [...path.matchAll(/\//g)].map((slash) => path.slice(0, slash.index))));
  const importers = new Map<string, string[]>();
  const reached = new Set(changed);
  for (const path of tracked) {
    if (!MODULE.test(path)) continue;
    const found = references(path, read(path), files, dirs);
    for (const target of found.files) importers.set(target, [...(importers.get(target) ?? []), path]);
    if ([...found.dirs].some((dir) => changed.some((file) => file.startsWith(`${dir}/`)))) reached.add(path);
  }
  for (const path of reached) for (const importer of importers.get(path) ?? []) reached.add(importer);
  if (RUNNERS.some((runner) => reached.has(runner))) return ALL;
  const paths = [...reached];
  return {
    core: paths.filter((path) => CORE_TEST.test(path) && files.has(path)).sort(),
    webUi: paths.some((path) => WEB_UI.test(path)),
    cli: paths.some((path) => CLI.test(path)),
  };
}

export function plan(selection: Selection, timings: Record<string, number>) {
  const total = Object.values(timings).reduce((sum, seconds) => sum + seconds, 0);
  const seconds =
    selection.core === "all" ? total : selection.core.reduce((sum, file) => sum + (timings[file] ?? 10), 0);
  const shards = selection.core === "all" ? 8 : Math.min(8, selection.core.length, Math.ceil(seconds / 240));
  return { seconds, share: seconds / total, shards };
}

function main() {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\n")
      .filter(Boolean);
  let selection = ALL;
  try {
    const base = process.env.CI_BASE;
    if (!base) throw new Error("No base commit, so every suite runs.");
    selection = select(git("diff", "--name-only", "--no-renames", base, "HEAD"), git("ls-files"), (path) =>
      readFileSync(path, "utf8"),
    );
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
  }
  const timings = JSON.parse(readFileSync(new URL("root-test-timings.json", import.meta.url), "utf8"));
  const { share, shards } = plan(selection, timings);
  const core = selection.core;
  const outputs = {
    "core-tests": JSON.stringify(core),
    shards: JSON.stringify(Array.from({ length: shards }, (_, i) => i + 1)),
    "shard-count": String(shards),
    "render-runner": String(core === "all" || core.includes("test/render-deploy-runner.test.ts")),
    "web-ui": String(selection.webUi),
    cli: String(selection.cli),
  };
  const summary = `Core tests: ${core === "all" ? "all" : core.length} files, ${Math.round(100 * share)}% of test-seconds, ${shards} shards. Web UI plugin: ${selection.webUi}. CLI: ${selection.cli}.`;
  console.log([summary, ...(core === "all" ? [] : core)].join("\n"));
  const { GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
  if (GITHUB_OUTPUT)
    appendFileSync(
      GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
