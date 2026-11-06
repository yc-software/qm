import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { defaultOutputDirectory, renderJunit } from "./evidence.mjs";

const root = new URL("../../", import.meta.url);
const manifestUrl = new URL("manifest.json", import.meta.url);

function outputDirectory(argv) {
  const index = argv.indexOf("--output-dir");
  if (index === -1) return process.env.FINNYLOOP_EVAL_OUTPUT_DIR ?? defaultOutputDirectory(Date.now(), process.pid);
  const value = argv[index + 1];
  if (!value || argv.length !== index + 2) throw new Error("Use --output-dir <directory>");
  return value;
}

function runCommand(command) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    if (command.requiresDatabase && !process.env.DATABASE_URL) {
      resolve({
        id: command.id,
        passed: false,
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdout,
        stderr: "DATABASE_URL is required for this authoritative test command\n",
      });
      return;
    }
    const executable = command.program === "node" ? process.execPath : command.program;
    const child = spawn(executable, command.args, {
      cwd: root,
      env: process.env,
      shell: false,
    });
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => {
      stderr += `${error.stack ?? error.message}\n`;
    });
    child.on("close", (exitCode, signal) => {
      resolve({
        id: command.id,
        passed: exitCode === 0 && signal === null,
        exitCode,
        signal,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

const started = Date.now();
const outputDir = outputDirectory(process.argv.slice(2));
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const commandResults = await Promise.all(manifest.commands.map((command) => runCommand(command)));
const resultById = new Map(commandResults.map((result) => [result.id, result]));
const caseResults = manifest.cases.map((candidate) => {
  const commandIds = [...new Set(candidate.selectors.map((selector) => selector.commandId))];
  const failedCommandIds = commandIds.filter((id) => !resultById.get(id)?.passed);
  return {
    id: candidate.id,
    passed: failedCommandIds.length === 0,
    invariant: candidate.invariant,
    selectors: candidate.selectors,
    commandIds,
    failedCommandIds,
    durationMs: commandIds.reduce((sum, id) => sum + (resultById.get(id)?.durationMs ?? 0), 0),
  };
});
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  cwd: root,
  encoding: "utf8",
});
const sourceHash = createHash("sha256").update(sourceRevision);
sourceHash.update(execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root }));
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .sort();
for (const path of untracked) {
  sourceHash.update(path);
  sourceHash.update(await readFile(new URL(path, root)));
}
const summary = {
  schema: "finnyloop-r5-eval-result.v1",
  manifestSchema: manifest.schema,
  sourceRevision,
  sourceStateDigest: sourceHash.digest("hex"),
  sourceDirty: sourceStatus.length > 0,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  passed: commandResults.every((result) => result.passed) && caseResults.every((candidate) => candidate.passed),
  liveServices: false,
  databaseConfigured: Boolean(process.env.DATABASE_URL),
  commands: commandResults,
  cases: caseResults,
};
const outputPath = resolve(root.pathname, outputDir);
await mkdir(outputPath, { recursive: true });
const jsonPath = resolve(outputPath, "summary.json");
const junitPath = resolve(outputPath, "junit.xml");
await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(junitPath, renderJunit(summary));
process.stdout.write(`\nFinnyLoop r5 evidence: ${jsonPath}\nFinnyLoop r5 JUnit: ${junitPath}\n`);
process.exitCode = summary.passed ? 0 : 1;
