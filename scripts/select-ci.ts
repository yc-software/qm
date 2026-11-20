import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const RUN_ALL = {
  exact: [
    "package.json",
    "package-lock.json",
    ".npmrc",
    ".node-version",
    "scripts/run-pg-tests.mjs",
    "scripts/run-root-test-shard.mjs",
    "scripts/select-ci.ts",
    "test/support/test-template.ts",
  ],
  prefixes: [".github/", "vendor/", "tsconfig"],
};
const RUNNERS = ["test/support/boot-tenant-entry.ts", "test/support/test-tenant.ts"];
const WEB_UI = ["plugins/web-ui/"];
const IMAGE = "deploy/core/Dockerfile";
const IMAGE_CHECKS = ["deploy/core", "scripts/smoke-core-image.sh", ".dockerignore"];
const CLI = ["cli/", "deploy/stacks/"];
const ROOT_PACKAGE = ["src/", "test/", "scripts/"];
const MODULES = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"];
const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.js"];

type Selection = { core: string[] | "all"; webUi: boolean; cli: boolean; coreImage: boolean };
const ALL: Selection = { core: "all", webUi: true, cli: true, coreImage: true };

const under = (path: string, prefixes: string[]) => prefixes.some((prefix) => path.startsWith(prefix));
const copied = (dockerfile: string) =>
  dockerfile
    .split("\n")
    .filter((line) => line.startsWith("COPY "))
    .flatMap((line) => line.split(" ").slice(1, -1))
    .filter((source) => !source.startsWith("--"));
const runsAll = (path: string) => RUN_ALL.exact.includes(path) || under(path, RUN_ALL.prefixes);
const isModule = (path: string) => MODULES.includes(posix.extname(path));
const isCoreTest = (path: string) => posix.dirname(path) === "test" && path.endsWith(".test.ts");

function runtimeCode(path: string, source: string) {
  if (![".ts", ".mts", ".cts"].includes(posix.extname(path))) return source;
  try {
    return stripTypeScriptTypes(source);
  } catch (error) {
    console.log(`${path}: ${error instanceof Error ? error.message : String(error)}; reading its type imports too.`);
    return source;
  }
}

function references(path: string, source: string, files: Set<string>, dirs: Set<string>) {
  const here = posix.dirname(path);
  const found = { files: new Set<string>(), dirs: new Set<string>() };
  const add = (target: string, candidates: string[]) => {
    const file = candidates.map((candidate) => posix.normalize(candidate)).find((candidate) => files.has(candidate));
    const dir = posix.normalize(target).replace(/\/$/, "");
    if (file && !runsAll(file)) found.files.add(file);
    else if (!file && dirs.has(dir)) found.dirs.add(dir);
  };
  const importEdge = (specifier: string) => {
    if (!specifier.startsWith(".")) return;
    const target = posix.join(here, specifier);
    add(target, [...EXTENSIONS.map((extension) => target + extension), target.replace(/\.js$/, ".ts")]);
  };
  const literalEdges = (text: string) => {
    for (const piece of text.split(/[\s=,:;()"']+/)) {
      if (!piece.replaceAll(".", "").replaceAll("/", "") || !(piece.includes("/") || posix.extname(piece))) continue;
      add(posix.join(here, piece), [posix.join(here, piece)]);
      if (!piece.startsWith(".")) add(piece.replace(/^\/+/, ""), [piece.replace(/^\/+/, "")]);
    }
  };
  const literals = under(path, ROOT_PACKAGE);
  const visit = (node: ts.Node): void => {
    const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;
    const loaded =
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0];
    if (loaded && ts.isStringLiteralLike(loaded)) return importEdge(loaded.text);
    if (specifier && ts.isStringLiteralLike(specifier)) return importEdge(specifier.text);
    if (literals && (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node))) literalEdges(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(path, runtimeCode(path, source), ts.ScriptTarget.Latest));
  return found;
}

export function select(changed: string[], tracked: string[], read: (path: string) => string): Selection {
  if (changed.length === 0) return { core: [], webUi: false, cli: false, coreImage: false };
  if (changed.some(runsAll)) return ALL;
  if (changed.some((path) => path.startsWith("src/") && !isModule(path))) return ALL;
  const files = new Set(tracked);
  const image = [...IMAGE_CHECKS, ...(files.has(IMAGE) ? copied(read(IMAGE)) : [])];
  const dirs = new Set(tracked.flatMap((path) => [...path.matchAll(/\//g)].map((slash) => path.slice(0, slash.index))));
  const importers = new Map<string, string[]>();
  const reached = new Set(changed);
  for (const path of tracked) {
    if (!isModule(path)) continue;
    const found = references(path, read(path), files, dirs);
    for (const target of found.files) importers.set(target, [...(importers.get(target) ?? []), path]);
    if ([...found.dirs].some((dir) => changed.some((file) => file.startsWith(`${dir}/`)))) reached.add(path);
  }
  for (const path of reached) for (const importer of importers.get(path) ?? []) reached.add(importer);
  if (RUNNERS.some((runner) => reached.has(runner))) return ALL;
  const paths = [...reached];
  return {
    core: paths.filter((path) => isCoreTest(path) && files.has(path)).sort(),
    webUi: paths.some((path) => under(path, WEB_UI)),
    cli: paths.some((path) => under(path, CLI)),
    coreImage: changed.some((path) => image.some((source) => path === source || path.startsWith(`${source}/`))),
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
    "core-image": String(selection.coreImage),
  };
  const summary = `Core tests: ${core === "all" ? "all" : core.length} files, ${Math.round(100 * share)}% of test-seconds, ${shards} shards. Web UI plugin: ${selection.webUi}. CLI: ${selection.cli}. Core image: ${selection.coreImage}.`;
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
