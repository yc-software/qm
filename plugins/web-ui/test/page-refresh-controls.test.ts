import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import test from "node:test";

const sourceDir = new URL("../src/", import.meta.url);

function sourceFiles(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name, dir);
    if (entry.isDirectory()) return sourceFiles(new URL(`${entry.name}/`, dir));
    return extname(entry.name) === ".ts" || extname(entry.name) === ".css" ? [child] : [];
  });
}

test("page headers do not expose manual refresh controls", () => {
  const source = sourceFiles(sourceDir)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(
    source,
    /pane-refresh|\bonRefresh\b|Refresh projects|Refresh memory|Refresh conversations|>Refresh<\/button>/,
  );
});
