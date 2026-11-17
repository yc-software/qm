#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TIMINGS = join(ROOT, "scripts/root-test-timings.json");
const DEFAULT_SECONDS = 10;
const JOBS_PER_SHARD = 4;
const MODULE = /\.(ts|tsx|mts|mjs|js|cjs)$/;
const ROOT_TEST = /^test\/[^/]+\.test\.ts$/;
const WHOLE_REPO_TEST = /\bls-files\b|recursive: true, encoding/;
const SPECIFIER = /(["'`])([\w@.\-/]+?)\1/g;
const INERT = /^(docs|adrs|ios)\/|^[^/]+\.md$/;

function rootTests() {
  return readdirSync(join(ROOT, "test"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `test/${name}`)
    .sort();
}

function readTimings() {
  return existsSync(TIMINGS) ? JSON.parse(readFileSync(TIMINGS, "utf8")) : {};
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
}

function resolveSpecifier(from, spec, known) {
  const bases = spec.startsWith(".") ? [join(dirname(from), spec)] : [spec, join(dirname(from), spec)];
  for (const base of bases.map(normalize)) {
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (known.has(candidate)) return candidate;
    }
  }
  return null;
}

function importers() {
  const known = new Set(git("ls-files").filter((file) => existsSync(join(ROOT, file))));
  const reverse = new Map();
  for (const file of [...known].filter((path) => MODULE.test(path))) {
    for (const [, , spec] of readFileSync(join(ROOT, file), "utf8").matchAll(SPECIFIER)) {
      if (!spec.includes("/")) continue;
      const target = resolveSpecifier(file, spec, known);
      if (!target || target === file) continue;
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(file);
    }
  }
  return reverse;
}

function affectedTests(base, all) {
  const reverse = importers();
  const selected = new Set(all.filter((file) => WHOLE_REPO_TEST.test(readFileSync(join(ROOT, file), "utf8"))));
  const queue = [];
  for (const file of git("diff", "--name-only", base, "HEAD")) {
    if (!existsSync(join(ROOT, file))) continue;
    if (/\.test\.tsx?$/.test(file)) {
      if (ROOT_TEST.test(file)) selected.add(file);
      continue;
    }
    if (file.startsWith("test/support/")) return { files: all, reason: file };
    if (reverse.has(file)) queue.push(file);
    else if (MODULE.test(file) || !INERT.test(file)) return { files: all, reason: file };
  }
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (ROOT_TEST.test(file)) selected.add(file);
    queue.push(...(reverse.get(file) ?? []));
  }
  return { files: all.filter((file) => selected.has(file)), reason: null };
}

function pack(files, all, total, timings) {
  const weight = (file) => timings[file] ?? DEFAULT_SECONDS;
  const seconds = (list) => list.reduce((sum, file) => sum + weight(file), 0);
  const share = seconds(all) / total;
  const load = (file) => (weight(file) * JOBS_PER_SHARD >= share ? weight(file) * JOBS_PER_SHARD : weight(file));
  const used = Math.min(total, Math.ceil(files.reduce((sum, file) => sum + load(file), 0) / share));
  const shards = Array.from({ length: total }, () => ({ seconds: 0, files: [] }));
  for (const file of files.toSorted((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.slice(0, used).reduce((min, shard) => (shard.seconds < min.seconds ? shard : min));
    lightest.files.push(file);
    lightest.seconds += load(file);
  }
  return shards;
}

function record(log) {
  const timings = readTimings();
  const runs = new Map();
  for (const [, file, seconds] of log.matchAll(/# (?:ok|FAIL) (test\/[^/\s]+\.test\.ts) \(([\d.]+)s\)/g)) {
    runs.set(file, [...(runs.get(file) ?? []), Number(seconds)]);
  }
  for (const [file, seconds] of runs) {
    timings[file] = Math.max(1, Math.round(seconds.reduce((sum, value) => sum + value, 0) / seconds.length));
  }
  const live = new Set(rootTests());
  const kept = Object.entries(timings)
    .filter(([file]) => live.has(file))
    .sort(([a], [b]) => a.localeCompare(b));
  writeFileSync(TIMINGS, `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`);
  console.error(`Recorded ${kept.length} root test timings`);
}

const { values } = parseArgs({
  options: {
    shard: { type: "string", default: process.env.CORE_TEST_SHARD || "1/1" },
    since: { type: "string", default: process.env.CORE_TEST_BASE || undefined },
    record: { type: "boolean" },
  },
});

if (values.record) {
  record(Buffer.concat(await Array.fromAsync(process.stdin)).toString("utf8"));
} else {
  const match = /^(\d+)\/(\d+)$/.exec(values.shard);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) {
    throw new Error(`Shard must be <index>/<total>, got ${values.shard}`);
  }
  const all = rootTests();
  const { files, reason } = values.since ? affectedTests(values.since, all) : { files: all, reason: "no diff base" };
  console.error(
    reason
      ? `All ${all.length} root test files run (${reason})`
      : `${files.length} of ${all.length} root test files are reachable from the diff against ${values.since}`,
  );
  const shard = pack(files, all, Number(match[2]), readTimings())[Number(match[1]) - 1];
  console.error(`Shard ${values.shard}: ${shard.files.length} files`);
  if (shard.files.length > 0) console.log(shard.files.join("\n"));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${shard.files.length > 0}\nfull=${files.length === all.length}\n`);
  }
}
