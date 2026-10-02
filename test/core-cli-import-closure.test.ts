import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Core images copy only the cli/src files named in deploy/core/Dockerfile. If core reaches any other
// cli/src file at runtime, the image fails at startup, so pin the import closure here.
const root = resolve(import.meta.dirname, "..");

const runtimeImports = (file: string): string[] =>
  [
    /^(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ]
    .flatMap((re) => [...readFileSync(file, "utf8").matchAll(re)].map((m) => m[1]!))
    .filter((spec) => spec.startsWith("."))
    .map((spec) => relative(root, resolve(dirname(file), spec)));

const tsFiles = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(root, dir, f));

test("core reaches only the cli/src files the core image copies, and those import nothing else", () => {
  const copyLine = /^COPY ((?:cli\/src\/\S+\s+)+)\.\/cli\/src\/$/m.exec(
    readFileSync(join(root, "deploy/core/Dockerfile"), "utf8"),
  );
  assert.ok(copyLine, "deploy/core/Dockerfile should COPY the shared cli/src files");
  const copied = new Set(copyLine[1]!.trim().split(/\s+/));

  const reached = tsFiles("src")
    .flatMap(runtimeImports)
    .filter((p) => p.startsWith("cli/"));
  assert.ok(reached.length > 0);
  for (const target of reached) assert.ok(copied.has(target), `core imports ${target}, which the image does not copy`);

  for (const file of copied) {
    for (const target of runtimeImports(join(root, file))) {
      assert.ok(copied.has(target), `${file} imports ${target}, which the image does not copy`);
    }
  }
});
