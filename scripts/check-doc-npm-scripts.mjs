#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const REPO_ROOT = new URL("../", import.meta.url);
const DOC_COMMAND = /npm run ([A-Za-z][\w:.-]*)/g;

function trackedFiles(pattern) {
  const out = execFileSync("git", ["ls-files", pattern], { cwd: REPO_ROOT, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function definedScripts() {
  const byPackage = new Map();
  for (const file of trackedFiles("*package.json")) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(new URL(file, REPO_ROOT), "utf8"));
    } catch (error) {
      throw new Error(`${file} is not valid JSON`, { cause: error });
    }
    byPackage.set(dirname(file), Object.keys(manifest.scripts ?? {}));
  }
  if (byPackage.size === 0) throw new Error("No package.json files are tracked — cannot resolve documented commands");
  return byPackage;
}

function documentedCommands() {
  const references = [];
  for (const file of trackedFiles("*.md")) {
    const lines = readFileSync(new URL(file, REPO_ROOT), "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(DOC_COMMAND)) {
        references.push({ script: match[1], where: `${file}:${index + 1}` });
      }
    }
  }
  return references;
}

function main() {
  const { values: flags } = parseArgs({ options: { list: { type: "boolean" } } });
  const byPackage = definedScripts();
  const known = new Set([...byPackage.values()].flat());
  const references = documentedCommands();

  if (flags.list) {
    for (const { script, where } of references) {
      console.log(`${known.has(script) ? "ok     " : "unknown"} npm run ${script}  ${where}`);
    }
    return;
  }

  const unknown = references.filter(({ script }) => !known.has(script));
  if (unknown.length > 0) {
    console.error("Documented npm commands that no package.json defines:\n");
    for (const { script, where } of unknown) console.error(`  ${where}: npm run ${script}`);
    console.error("\nEither add the script, correct the docs, or drop the command from the docs.");
    throw new Error(`${unknown.length} documented npm command(s) do not exist`);
  }

  const scripts = new Set(references.map((r) => r.script));
  console.log(
    `Checked ${references.length} documented npm command(s) (${scripts.size} distinct) across ${byPackage.size} packages — all defined.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
