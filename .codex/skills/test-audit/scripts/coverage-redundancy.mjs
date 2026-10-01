#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    jobs: { type: "string", default: "6" },
    budget: { type: "string", default: "0" },
    serial: { type: "string", multiple: true, default: [] },
    out: { type: "string", default: "coverage-redundancy.json" },
    timeout: { type: "string", default: "900" },
    src: { type: "string", multiple: true, default: ["src", "scripts", "plugins/chassis", "deploy", "cli/src"] },
  },
});

const root = process.cwd();
const measured = values.src.map((d) => path.join(root, d));
const skipped = (file) => /\/(node_modules|test|dist|\.generated)\//.test(file) || /\.test\.[cm]?[jt]s$/.test(file);
const files =
  positionals.length > 0
    ? positionals
    : readdirSync(path.join(root, "test"))
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => `test/${f}`)
        .sort();
const serial = new Set(values.serial);
const lineStarts = new Map();

function startsOf(file) {
  let hit = lineStarts.get(file);
  if (!hit) {
    const text = readFileSync(file, "utf8");
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    hit = { text, starts };
    lineStarts.set(file, hit);
  }
  return hit;
}

function coveredLines(dir) {
  const covered = new Set();
  for (const name of readdirSync(dir)) {
    let report;
    try {
      report = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    for (const script of report.result ?? []) {
      if (!script.url.startsWith("file://")) continue;
      const file = decodeURIComponent(script.url.slice("file://".length));
      if (!measured.some((d) => file.startsWith(`${d}/`)) || skipped(file) || !existsSync(file)) continue;
      const { text, starts } = startsOf(file);
      const ranges = script.functions
        .flatMap((fn) => fn.ranges)
        .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
      const paint = new Uint8Array(text.length);
      for (const r of ranges) paint.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, text.length));
      const rel = path.relative(root, file);
      for (let line = 0; line < starts.length; line += 1) {
        const end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
        for (let i = starts[line]; i < end; i += 1) {
          const c = text.charCodeAt(i);
          if (paint[i] && c !== 32 && c !== 9 && c !== 13) {
            covered.add(`${rel}:${line + 1}`);
            break;
          }
        }
      }
    }
  }
  return covered;
}

function runOne(file) {
  return new Promise((resolve) => {
    const dir = mkdtempSync(path.join(tmpdir(), "qm-cov-"));
    const started = Date.now();
    const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--test", file], {
      cwd: root,
      env: { ...process.env, NODE_V8_COVERAGE: dir },
      stdio: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), Number(values.timeout) * 1000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const lines = coveredLines(dir);
      rmSync(dir, { recursive: true, force: true });
      resolve({ file, code, ms: Date.now() - started, lines });
    });
  });
}

async function runAll() {
  const results = [];
  const parallel = files.filter((f) => !serial.has(f));
  let next = 0;
  const workers = Array.from({ length: Number(values.jobs) }, async () => {
    while (next < parallel.length) {
      const file = parallel[next++];
      results.push(await runOne(file));
      process.stderr.write(`${results.length}/${files.length} ${file}\n`);
    }
  });
  await Promise.all(workers);
  for (const file of files.filter((f) => serial.has(f))) {
    results.push(await runOne(file));
    process.stderr.write(`${results.length}/${files.length} ${file}\n`);
  }
  return results;
}

function denominator() {
  let total = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!skipped(`${full}/`)) walk(full);
      } else if (/\.(ts|mjs)$/.test(name) && !skipped(full))
        total += readFileSync(full, "utf8")
          .split("\n")
          .filter((l) => l.trim()).length;
    }
  };
  for (const dir of measured) if (existsSync(dir)) walk(dir);
  return total;
}

const results = (await runAll()).map((r) => (r.code === 0 ? r : { ...r, lines: new Set() }));
const counts = new Map();
for (const r of results) for (const l of r.lines) counts.set(l, (counts.get(l) ?? 0) + 1);
const total = denominator();
const loc = (f) => readFileSync(path.join(root, f), "utf8").split("\n").length;
const rows = results.map((r) => ({
  file: r.file,
  exit: r.code,
  ms: r.ms,
  loc: loc(r.file),
  covered: r.lines.size,
  unique: [...r.lines].filter((l) => counts.get(l) === 1).length,
}));
const budget = Number(values.budget);
let lost = 0;
const pool = [];
for (const row of [...rows].sort((a, b) => a.unique / a.loc - b.unique / b.loc)) {
  const lines = results.find((r) => r.file === row.file).lines;
  const loss = [...lines].filter((l) => counts.get(l) === 1).length;
  if (lost + loss > budget) continue;
  for (const l of lines) counts.set(l, counts.get(l) - 1);
  lost += loss;
  pool.push({ ...row, jointLoss: loss });
}
const summary = {
  srcLines: total,
  coveredLines: [...new Set(results.flatMap((r) => [...r.lines]))].length,
  failures: rows.filter((r) => r.exit !== 0).map((r) => r.file),
  pool: { files: pool.length, loc: pool.reduce((s, r) => s + r.loc, 0), lostLines: lost },
};
writeFileSync(values.out, JSON.stringify({ summary, rows, pool }, null, 1));
console.log(JSON.stringify(summary, null, 1));
