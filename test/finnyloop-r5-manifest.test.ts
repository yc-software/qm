import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const manifestUrl = new URL("../evals/finnyloop-r5/manifest.json", import.meta.url);
const runnerUrl = new URL("../evals/finnyloop-r5/run.mjs", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const repositoryUrl = new URL("../", import.meta.url);
const requiredCases = [
  "plan-digest-tampering",
  "approval-wrong-actor",
  "approval-wrong-thread",
  "approval-replay",
  "worker-role-run-forgery",
  "artifact-replacement-without-rework",
  "stale-generation",
  "latest-block-after-pass",
  "incomplete-one-check-certificate",
  "lineage-selective-invalidation",
  "block-wakes-producer-and-rotates-auditor",
  "configured-escalation-boundary",
  "deterministic-output-mutation",
  "deterministic-output-nondeterminism",
  "pi-restart-checkpoint-mismatch",
  "slack-opaque-action-tampering-recovery",
  "final-receipt-idempotency-binding",
  "process-death-pending-plan-recovery",
  "process-death-approved-dispatch-recovery",
] as const;

test("FinnyLoop r5 manifest maps every adversarial case to authoritative offline evidence", async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
    schema?: string;
    liveServices?: boolean;
    commands?: Array<{
      id?: string;
      program?: string;
      args?: string[];
      requiresDatabase?: boolean;
    }>;
    cases?: Array<{
      id?: string;
      invariant?: string;
      selectors?: Array<{ commandId?: string; file?: string; name?: string; declarationTokens?: string[] }>;
    }>;
  };
  assert.equal(manifest.schema, "finnyloop-r5-eval.v1");
  assert.equal(manifest.liveServices, false);
  const commands = manifest.commands ?? [];
  assert.ok(commands.length > 0);
  const commandIds = new Set(commands.map((command) => command.id));
  assert.equal(commandIds.size, commands.length);
  assert.ok(commands.some((command) => command.requiresDatabase));
  for (const command of commands) {
    assert.equal(command.program, "node");
    assert.ok(command.id);
    assert.ok(command.args?.length);
    assert.equal(
      command.args?.some((argument) => argument.includes("live")),
      false,
    );
    if (command.requiresDatabase) {
      assert.equal(command.args?.filter((argument) => argument.endsWith(".test.ts")).length, 1);
    }
  }
  const cases = manifest.cases ?? [];
  assert.deepEqual(cases.map((candidate) => candidate.id).sort(), [...requiredCases].sort());
  for (const candidate of cases) {
    assert.ok(candidate.invariant?.trim());
    assert.ok(candidate.selectors?.length);
    for (const selector of candidate.selectors ?? []) {
      assert.ok(commandIds.has(selector.commandId));
      assert.ok(selector.file?.endsWith(".test.ts"));
      assert.ok(selector.name?.trim());
      const selectorUrl = new URL(selector.file ?? "", repositoryUrl);
      await access(selectorUrl);
      const source = await readFile(selectorUrl, "utf8");
      const staticallyDeclared = source.includes(JSON.stringify(selector.name));
      const dynamicallyDeclared =
        selector.declarationTokens?.length && selector.declarationTokens.every((token) => source.includes(token));
      assert.ok(staticallyDeclared || dynamicallyDeclared, `${selector.file} does not declare ${selector.name}`);
      const command = commands.find((entry) => entry.id === selector.commandId);
      assert.ok(command?.args?.includes(selector.file ?? ""));
    }
  }
  await access(runnerUrl);
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.["eval:finnyloop-r5"], "node evals/finnyloop-r5/run.mjs");
});

test("FinnyLoop r5 runner preserves fail-closed machine evidence without DATABASE_URL", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const output = await mkdtemp(join(tmpdir(), "finnyloop-r5-eval-"));
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const env = { ...process.env };
      delete env.DATABASE_URL;
      const child = spawn(process.execPath, [runnerUrl.pathname, "--output-dir", output], {
        cwd: repositoryUrl,
        env,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1);
    const summary = JSON.parse(await readFile(join(output, "summary.json"), "utf8")) as {
      schema?: string;
      passed?: boolean;
      sourceRevision?: string;
      sourceStateDigest?: string;
      sourceDirty?: boolean;
      commands?: Array<{ id?: string; passed?: boolean; stderr?: string }>;
      cases?: Array<{ id?: string; passed?: boolean; failedCommandIds?: string[] }>;
    };
    assert.equal(summary.schema, "finnyloop-r5-eval-result.v1");
    assert.equal(summary.passed, false);
    assert.equal(summary.sourceRevision?.length, 40);
    assert.equal(summary.sourceStateDigest?.length, 64);
    assert.equal(typeof summary.sourceDirty, "boolean");
    assert.match(
      summary.commands?.find((command) => command.id === "finny-runtime-postgres")?.stderr ?? "",
      /DATABASE_URL/,
    );
    assert.ok(summary.commands?.find((command) => command.id === "finny-pi-offline")?.passed);
    assert.equal(summary.cases?.length, requiredCases.length);
    assert.ok(summary.cases?.some((candidate) => candidate.failedCommandIds?.includes("finny-runtime-postgres")));
    assert.match(await readFile(join(output, "junit.xml"), "utf8"), /failures="[1-9]/);
    assert.match(result.stdout, /FinnyLoop r5 evidence/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("FinnyLoop r5 JUnit preserves stdout and stderr failure evidence", async () => {
  const { renderJunit } = await import("../evals/finnyloop-r5/evidence.mjs");
  const rendered = renderJunit({
    durationMs: 4,
    commands: [{ id: "command-1", stdout: "assertion from stdout", stderr: "diagnostic from stderr" }],
    cases: [
      {
        id: "case-1",
        passed: false,
        invariant: "must fail closed",
        selectors: [{ file: "test/example.test.ts", name: "example" }],
        failedCommandIds: ["command-1"],
        durationMs: 4,
      },
    ],
  });
  assert.match(rendered, /assertion from stdout/);
  assert.match(rendered, /diagnostic from stderr/);
});

test("FinnyLoop r5 default evidence path stays outside the source tree", async () => {
  const { defaultOutputDirectory } = await import("../evals/finnyloop-r5/evidence.mjs");
  const { tmpdir } = await import("node:os");
  const output = defaultOutputDirectory(1234, 99);
  assert.ok(output.startsWith(tmpdir()));
  assert.match(output, /1234-99$/);
});
