import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type BenchTask } from "./core/types.ts";

export interface BenchCase {
  id: string;
  task: string;
  variant: number;
  family: string;
  difficulty: string;
  prompt: string;
  followUp: string | null;
  outputs: string[];
  files: Record<string, string>;
  privateFiles: Record<string, string>;
  key: unknown;
}

export function buildCases(tasks: BenchTask[], variants: number[]): BenchCase[] {
  return tasks.flatMap((task) =>
    variants.map((variant) => {
      const fixture = task.generate(variant);
      return {
        id: `${task.id}-${variant}`,
        task: task.id,
        variant,
        family: task.family,
        difficulty: task.difficulty,
        prompt: task.prompt(fixture),
        followUp: task.followUp ? task.followUp(fixture) : null,
        outputs: task.outputs,
        files: fixture.files,
        privateFiles: fixture.privateFiles,
        key: fixture.key,
      };
    }),
  );
}

export function parseVariants(spec: string): number[] {
  const variants = new Set<number>();
  for (const part of spec.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) variants.add(n);
  }
  return [...variants];
}

export function assertCasePath(path: string): string {
  const parts = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || parts.some((p) => p === "" || p === "." || p === ".."))
    throw new Error(`unsafe case path: ${path}`);
  return path;
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, assertCasePath(path));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
  return out;
}

export function writeCases(dir: string, cases: BenchCase[]): void {
  rmSync(dir, { recursive: true, force: true });
  for (const c of cases) {
    const root = join(dir, c.id);
    mkdirSync(root, { recursive: true });
    const { files, privateFiles, ...meta } = c;
    writeFileSync(join(root, "case.json"), JSON.stringify(meta, null, 2));
    writeTree(join(root, "files"), files);
    writeTree(join(root, "private"), privateFiles);
  }
}

export function loadCases(dir: string): BenchCase[] {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort()
    .map((name) => {
      const root = join(dir, name);
      const meta = JSON.parse(readFileSync(join(root, "case.json"), "utf8")) as Omit<
        BenchCase,
        "files" | "privateFiles"
      >;
      if (meta.id !== name) throw new Error(`case directory ${name} holds case ${meta.id}`);
      for (const id of [meta.id, meta.task])
        if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new Error(`unsafe identifier: ${id}`);
      for (const path of meta.outputs)
        if (!assertCasePath(path).startsWith("output/")) throw new Error(`deliverable outside output/: ${path}`);
      return { ...meta, files: readTree(join(root, "files")), privateFiles: readTree(join(root, "private")) };
    });
}
