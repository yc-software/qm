#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { availableParallelism } from "node:os";
import process from "node:process";
import { parseArgs } from "node:util";
import pg from "pg";
import { rootTestFiles } from "./root-test-files.mjs";

const { values, positionals } = parseArgs({
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
const files = (positionals.length > 0 ? positionals : await rootTestFiles()).toSorted(
  (a, b) => statSync(b).size - statSync(a).size,
);

const { NODE_TEST_CONTEXT: _parentTestContext, ...inheritedEnv } = process.env;
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("Set DATABASE_URL to a Postgres server the tests may create databases on");
const runId = `qmt_${process.pid}_${randomBytes(4).toString("hex")}`;
const children = new Set();
const admin = new pg.Pool({ connectionString: baseUrl, max: jobs });
let stopping = false;
let ended = null;

function endPool() {
  ended ??= admin.end();
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
    let reason = null;
    const finish = (failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      children.delete(child);
      resolve({ file, ok: failure === null, reason: failure, ms: Date.now() - started, output });
    };
    const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--test", file], {
      detached: true,
      env: { ...inheritedEnv, ...env },
    });
    children.add(child);
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      output += `\n${file} exceeded ${timeoutSeconds}s and was killed\n`;
      reason = `timed out after ${timeoutSeconds}s`;
      killGroup(child);
    }, timeoutSeconds * 1000);
    child.on("error", (error) => {
      output += `\n${file} could not run: ${error.message || error.code || error}\n`;
      finish(`could not run: ${error.message || error.code || error}`);
    });
    child.on("exit", () => killGroup(child));
    child.on("close", (code, signal) => {
      if (reason ?? signal) finish(reason ?? `killed by ${signal}`);
      else finish(code === 0 ? null : `exited ${code}`);
    });
  });
}

async function runIsolated(file, index) {
  const name = `${runId}_${index}`;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    if (stopping) return { file, ok: false, reason: "stopped", ms: 0, output: "" };
    return await runFile(file, { DATABASE_URL: databaseUrl(name), QM_TEST_TEMPLATE_DATABASE: templateName });
  } finally {
    await dropDatabase(name);
  }
}

const templateName = `${runId}_template`;

function migrateTemplate() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [new URL("../test/support/test-template.ts", import.meta.url).pathname, databaseUrl(templateName)],
      { env: inheritedEnv, stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Migrating ${templateName} exited ${code}`)),
    );
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function dropAbandonedRuns() {
  const { rows } = await admin.query(
    `SELECT DISTINCT substring(d.datname from '^(qmt_[0-9]+_[0-9a-f]+)') AS run
       FROM pg_database d
      WHERE d.datname ~ '^qmt_[0-9]+_[0-9a-f]+'
        AND NOT EXISTS (
          SELECT 1 FROM pg_stat_activity a
           WHERE starts_with(a.datname, substring(d.datname from '^(qmt_[0-9]+_[0-9a-f]+)'))
        )`,
  );
  const abandoned = rows.map((row) => row.run).filter((run) => !alive(Number(run.split("_")[1])));
  for (const run of abandoned) await dropDatabase(run);
  if (abandoned.length > 0) process.stdout.write(`# dropped databases left by ${abandoned.length} killed runs\n`);
}

const started = Date.now();
process.stdout.write(`# run ${runId}: ${files.length} files with ${jobs} jobs\n`);
await dropAbandonedRuns();
await admin.query(`CREATE DATABASE ${templateName}`);
await migrateTemplate().catch(async (error) => {
  await dropDatabase(templateName);
  await endPool();
  throw error;
});
const results = [];
let next = 0;
const work = Promise.all(
  Array.from({ length: Math.min(jobs, files.length) }, async () => {
    while (!stopping && next < files.length) {
      const index = next++;
      const result = await runIsolated(files[index], index).catch((error) => ({
        file: files[index],
        ok: false,
        reason: `could not run: ${error.message || error.code || error}`,
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
      await dropDatabase(runId).catch(() => {});
      await endPool();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}

await work;
if (stopping) await new Promise(() => {});
await dropDatabase(runId);
await endPool();

const reported = new Set(results.map((result) => result.file));
const failed = [
  ...results.filter((result) => !result.ok),
  ...files.filter((file) => !reported.has(file)).map((file) => ({ file, reason: "never reported a result" })),
];
const summedMs = results.reduce((sum, result) => sum + result.ms, 0);
process.stdout.write(
  `\n# run ${runId}: ${files.length - failed.length}/${files.length} files passed with ${jobs} jobs in ${((Date.now() - started) / 1000).toFixed(1)}s (${(summedMs / 1000).toFixed(1)}s summed)\n`,
);
for (const result of failed) process.stdout.write(`# FAIL ${result.file}: ${result.reason}\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
