#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import process from "node:process";
import { parseArgs } from "node:util";
import pg from "pg";

const { values, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    jobs: { type: "string", default: process.env.PG_TEST_JOBS ?? String(Math.min(4, availableParallelism())) },
    timeout: { type: "string", default: "600" },
  },
});

const jobs = Number(values.jobs);
const timeoutSeconds = Number(values.timeout);
if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs must be a positive integer, got ${values.jobs}`);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  throw new Error(`--timeout must be a positive number of seconds, got ${values.timeout}`);
}
if (files.length === 0) throw new Error("Pass the Postgres test files to run");

const baseUrl = process.env.DATABASE_URL;
const runId = `qmt_${process.pid}_${randomBytes(4).toString("hex")}`;
const children = new Set();
const admin = baseUrl ? new pg.Pool({ connectionString: baseUrl, max: jobs }) : null;
let stopping = false;
let ended = null;

function endPool() {
  ended ??= admin?.end();
  return ended;
}

function killGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function databaseUrl(name) {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabase(name) {
  const { rows } = await admin.query(
    "SELECT datname FROM pg_database WHERE datname = $1 OR starts_with(datname, $1 || '_') ORDER BY datname DESC",
    [name],
  );
  for (const { datname } of rows) {
    await admin.query(`DROP DATABASE IF EXISTS "${datname.replaceAll('"', '""')}" WITH (FORCE)`);
  }
}

function runFile(file, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      resolve({ file, ok, ms: Date.now() - started, output });
    };
    const child = spawn(process.execPath, ["--test", file], { detached: true, env: { ...process.env, ...env } });
    children.add(child);
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      output += `\n${file} exceeded ${timeoutSeconds}s and was killed\n`;
      killGroup(child);
    }, timeoutSeconds * 1000);
    child.on("error", (error) => {
      output += `\n${file} could not run: ${error.message || error.code || error}\n`;
      finish(false);
    });
    child.on("exit", () => killGroup(child));
    child.on("close", (code, signal) => finish(code === 0 && !signal));
  });
}

async function runIsolated(file, index) {
  if (!admin) return runFile(file, {});
  const name = `${runId}_${index}`;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    if (stopping) return { file, ok: false, ms: 0, output: "" };
    return await runFile(file, { DATABASE_URL: databaseUrl(name) });
  } finally {
    await dropDatabase(name);
  }
}

const started = Date.now();
const results = [];
let next = 0;
const work = Promise.all(
  Array.from({ length: Math.min(jobs, files.length) }, async () => {
    while (!stopping && next < files.length) {
      const index = next++;
      const result = await runIsolated(files[index], index).catch((error) => ({
        file: files[index],
        ok: false,
        ms: 0,
        output: `\n${files[index]} could not run: ${error.message || error.code || error}\n`,
      }));
      if (stopping) return;
      results.push(result);
      process.stdout.write(`\n# ${result.ok ? "ok" : "FAIL"} ${result.file} (${(result.ms / 1000).toFixed(1)}s)\n`);
      process.stdout.write(result.output);
    }
  }),
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) killGroup(child);
    void work.then(async () => {
      await endPool();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

await work;
if (stopping) await new Promise(() => {});
await endPool();

const failed = results.filter((result) => !result.ok);
const summedMs = results.reduce((sum, result) => sum + result.ms, 0);
process.stdout.write(
  `\n# ${results.length - failed.length}/${results.length} files passed with ${jobs} jobs in ${((Date.now() - started) / 1000).toFixed(1)}s (${(summedMs / 1000).toFixed(1)}s summed)\n`,
);
for (const result of failed) process.stdout.write(`# FAIL ${result.file}\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
