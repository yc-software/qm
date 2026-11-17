#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

const ROOT = new URL("../", import.meta.url);
const TIMINGS = new URL("root-test-timings.json", import.meta.url);
const DEFAULT_SECONDS = 10;
const JOBS_PER_SHARD = 4;

function rootTests() {
  return readdirSync(new URL("test/", ROOT))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `test/${name}`)
    .sort();
}

function pack(files, total, timings) {
  const weight = (file) => timings[file] ?? DEFAULT_SECONDS;
  const share = files.reduce((sum, file) => sum + weight(file), 0) / total;
  const load = (file) => (weight(file) * JOBS_PER_SHARD >= share ? weight(file) * JOBS_PER_SHARD : weight(file));
  const shards = Array.from({ length: total }, () => ({ seconds: 0, files: [] }));
  for (const file of files.toSorted((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((min, shard) => (shard.seconds < min.seconds ? shard : min));
    lightest.files.push(file);
    lightest.seconds += load(file);
  }
  return shards.map((shard) => shard.files);
}

const { values } = parseArgs({
  options: {
    shard: { type: "string", default: process.env.CORE_TEST_SHARD },
    list: { type: "boolean" },
  },
});

const match = /^(\d+)\/(\d+)$/.exec(values.shard ?? "");
if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) {
  throw new Error(`Pass --shard <index>/<total> or set CORE_TEST_SHARD, got ${values.shard}`);
}
const selected = JSON.parse(process.env.CORE_TESTS ?? '"all"');
const files = pack(
  rootTests().filter((file) => selected === "all" || selected.includes(file)),
  Number(match[2]),
  JSON.parse(readFileSync(TIMINGS, "utf8")),
)[Number(match[1]) - 1];
console.log(`Root test shard ${values.shard} (${files.length} files):\n${files.map((file) => `  ${file}`).join("\n")}`);
if (!values.list && files.length > 0) {
  spawn(process.execPath, ["scripts/run-pg-tests.mjs", ...files], { cwd: ROOT, stdio: "inherit" }).on(
    "exit",
    (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)),
  );
}
