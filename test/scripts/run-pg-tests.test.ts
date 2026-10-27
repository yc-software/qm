import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const runner = new URL("../../scripts/run-pg-tests.mjs", import.meta.url).pathname;

function writeFiles(sources: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "run-pg-tests-"));
  return Object.fromEntries(
    Object.entries(sources).map(([name, source]) => {
      const path = join(dir, `${name}.test.ts`);
      writeFileSync(path, `import test from "node:test";\nimport assert from "node:assert/strict";\n${source}\n`);
      return [name, path];
    }),
  );
}

function run(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

const statusLines = (stdout: string) => stdout.split("\n").filter((line) => /^# (ok|FAIL) /.test(line));

test("a failing file among passing ones is counted, listed and fails the run", async () => {
  const files = writeFiles({
    passA: `test("a", () => assert.ok(true));`,
    passB: `test("b", () => assert.ok(true));`,
    passC: `test("c", () => assert.ok(true));`,
    assertion: `test("fails", () => assert.equal(1, 2));`,
    crash: `throw new Error("boom at import");`,
  });
  const { code, stdout } = await run(["--jobs", "3", ...Object.values(files)]);

  assert.equal(code, 1);
  assert.match(stdout, /^# run qmt_\d+_[0-9a-f]+: 3\/5 files passed with 3 jobs/m);
  assert.deepEqual(
    statusLines(stdout)
      .filter((line) => / \(\d+\.\ds\)$/.test(line))
      .map((line) => line.replace(/ \(\d+\.\ds\)$/, ""))
      .sort(),
    [
      `# FAIL ${files.assertion}`,
      `# FAIL ${files.crash}`,
      `# ok ${files.passA}`,
      `# ok ${files.passB}`,
      `# ok ${files.passC}`,
    ].sort(),
  );
  const listed = stdout.slice(stdout.lastIndexOf("files passed with")).split("\n").slice(1).filter(Boolean);
  assert.deepEqual(listed.sort(), [`# FAIL ${files.assertion}: exited 1`, `# FAIL ${files.crash}: exited 1`].sort());
});

test("a clean run exits zero and lists no failures", async () => {
  const files = writeFiles({ passA: `test("a", () => assert.ok(true));`, passB: `test("b", () => assert.ok(true));` });
  const { code, stdout } = await run(["--jobs", "3", ...Object.values(files)]);

  assert.equal(code, 0);
  assert.match(stdout, /: 2\/2 files passed with 3 jobs/);
  assert.doesNotMatch(stdout, /^# FAIL/m);
});

test("a file killed for running too long is listed with the reason", async () => {
  const files = writeFiles({ hang: `test("hangs", () => new Promise(() => setInterval(() => {}, 1000)));` });
  const { code, stdout } = await run(["--jobs", "3", "--timeout", "1", files.hang!]);

  assert.equal(code, 1);
  assert.match(stdout, /: 0\/1 files passed/);
  assert.ok(stdout.includes(`# FAIL ${files.hang}: timed out after 1s`));
});
