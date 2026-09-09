import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFactoryItem, parseVector } from "../src/loops/factory/evaluate.ts";
import type { FactoryEvaluateInput } from "../src/loops/factory/evaluate.ts";
import type { ExecResult } from "../src/sandbox/sandbox.ts";
import type { SuccessVerdict } from "../src/loops/success-evaluation.ts";

const SHA = "9bd011dab002ff48f39f0a65e5c56f8f44920880";
const MR_NUMBER = 2311;
const BRANCH = "qm-12-s17868";

const GREEN_VECTOR: Record<string, string> = {
  head_sha: SHA,
  mr_state: "opened",
  source_branch: BRANCH,
  exact_head: "true",
  exact_head_detail: "match",
  ci_green_on_head: "true",
  ci_green_on_head_detail: "success",
  ledger_clean: "true",
  ledger_clean_detail: "no_open_comments",
  mergeable: "true",
  mergeable_detail: "can_be_merged",
  vector_readable: "true",
};

const vectorStdout = (overrides: Record<string, string | null> = {}): string => {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(GREEN_VECTOR)) {
    const resolved = Object.hasOwn(overrides, key) ? overrides[key] : value;
    if (resolved !== null && resolved !== undefined) lines.push(`${key}=${resolved}`);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (Object.hasOwn(GREEN_VECTOR, key) || value === null) continue;
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
};

const recorder = (result: Partial<ExecResult> = {}) => {
  const commands: string[] = [];
  const argCounts: number[] = [];
  const exec = async (...args: unknown[]): Promise<ExecResult> => {
    commands.push(args[0] as string);
    argCounts.push(args.length);
    return {
      stdout: vectorStdout(),
      stderr: "",
      code: 0,
      timedOut: false,
      pressure: { ioFull10: 0, ioFull60: 0, load1: 0 },
      ...result,
    };
  };
  return { exec, commands, argCounts };
};

const evaluate = (
  exec: FactoryEvaluateInput["exec"],
  overrides: Partial<FactoryEvaluateInput> = {},
): Promise<SuccessVerdict> =>
  evaluateFactoryItem({ exec, attempt: 1, mrNumber: MR_NUMBER, branch: BRANCH, ...overrides });

const MET_VERDICT: SuccessVerdict = {
  outcome: "met",
  reason: "all convergence checks passed",
  checks: [
    { command: "exact_head", passed: true, detail: "match" },
    { command: "ci_green_on_head", passed: true, detail: "success" },
    { command: "ledger_clean", passed: true, detail: "no_open_comments" },
    { command: "mergeable", passed: true, detail: "can_be_merged" },
  ],
  judged: true,
};

test("a fully green vector converges, and chatter on stderr does not change that", async () => {
  const run = recorder({ stdout: vectorStdout(), stderr: "warning: refreshing token" });

  const verdict = await evaluate(run.exec, { headSha: SHA });

  assert.deepEqual(verdict, MET_VERDICT);
  assert.deepEqual(run.argCounts, [1]);
});

test("the first check that is not exactly true stops the run and carries its detail", async () => {
  const run = recorder({
    stdout: vectorStdout({ ci_green_on_head: "false", ci_green_on_head_detail: "pipeline_running" }),
  });

  const verdict = await evaluate(run.exec, { headSha: SHA });

  assert.deepEqual(verdict, {
    outcome: "continue",
    reason: "check failed: ci_green_on_head — pipeline_running",
    checks: [
      { command: "exact_head", passed: true, detail: "match" },
      { command: "ci_green_on_head", passed: false, detail: "pipeline_running" },
    ],
    judged: false,
  });
  assert.equal(run.commands.length, 1);
});

test("no value other than the exact string true is read as a passing check", async () => {
  for (const token of ["unknown", "TRUE", " true", "true\r"]) {
    const run = recorder({ stdout: vectorStdout({ mergeable: token }) });

    const verdict = await evaluate(run.exec);

    assert.equal(verdict.outcome, "continue", `token ${JSON.stringify(token)} must not pass`);
    assert.equal(verdict.judged, false);
    assert.deepEqual(verdict.checks.at(-1), { command: "mergeable", passed: false, detail: "can_be_merged" });
  }
});

test("a check the script never printed fails instead of passing by omission", async () => {
  const run = recorder({ stdout: vectorStdout({ ledger_clean: null, ledger_clean_detail: null }) });

  const verdict = await evaluate(run.exec);

  assert.deepEqual(verdict.checks.at(-1), { command: "ledger_clean", passed: false });
  assert.equal(verdict.reason, "check failed: ledger_clean");
  assert.equal(verdict.judged, false);
  assert.equal(verdict.outcome, "continue");
});

const UNREADABLE_ROWS: { name: string; result: Partial<ExecResult>; detail: string }[] = [
  {
    name: "non-zero exit with nothing on stdout",
    result: { code: 78, stdout: "", stderr: "glab: 401 Unauthorized" },
    detail: "vector_error: exit 78",
  },
  {
    name: "the script reported itself unreadable",
    result: { code: 0, stdout: vectorStdout({ vector_readable: "false", vector_error: "auth" }) },
    detail: "vector_error: auth",
  },
  {
    name: "stdout truncated before vector_readable was printed",
    result: { code: 0, stdout: vectorStdout({ vector_readable: null }) },
    detail: "vector_error: exit 0",
  },
  {
    name: "an all-green stdout behind a non-zero exit",
    result: { code: 78, stdout: vectorStdout(), stderr: "killed by signal" },
    detail: "vector_error: exit 78",
  },
];

test("an unreadable vector fails closed and never reaches the judge", async () => {
  for (const row of UNREADABLE_ROWS) {
    const run = recorder(row.result);

    const verdict = await evaluate(run.exec, { headSha: SHA });

    assert.deepEqual(
      verdict,
      {
        outcome: "continue",
        reason: `check failed: exact_head — ${row.detail}`,
        checks: [{ command: "exact_head", passed: false, detail: row.detail }],
        judged: false,
      },
      row.name,
    );
    assert.equal(run.commands.length, 1, row.name);
  }
});

test("an item is never parked, however many attempts it has taken", async () => {
  for (const attempt of [0, 999]) {
    for (const result of [{ stdout: vectorStdout({ mergeable: "false" }) }, { code: 78, stdout: "" }]) {
      const run = recorder(result);

      const verdict = await evaluate(run.exec, { attempt });

      assert.equal(verdict.outcome, "continue", `attempt ${attempt}`);
      assert.equal(verdict.reason.includes("attempt cap"), false, `attempt ${attempt}`);
    }
  }
});

test("the script is run once with every argument shell-quoted", async () => {
  const withSha = recorder();
  await evaluate(withSha.exec, { headSha: SHA });
  assert.deepEqual(withSha.commands, [`bash tools/factory/converge-vector.sh 2311 qm-12-s17868 ${SHA}`]);

  for (const headSha of [undefined, ""]) {
    const run = recorder();
    await evaluate(run.exec, { headSha });
    assert.deepEqual(run.commands, ["bash tools/factory/converge-vector.sh 2311 qm-12-s17868"]);
  }

  const spacedPath = recorder();
  await evaluate(spacedPath.exec, { scriptPath: "/tmp/my scripts/converge-vector.sh" });
  assert.deepEqual(spacedPath.commands, ["bash '/tmp/my scripts/converge-vector.sh' 2311 qm-12-s17868"]);

  for (const [branch, expected] of [
    ["qm-12; rm -rf /", "'qm-12; rm -rf /'"],
    ["it's-a-branch", "'it'\\''s-a-branch'"],
  ]) {
    const run = recorder();
    await evaluate(run.exec, { branch });
    assert.deepEqual(run.commands, [`bash tools/factory/converge-vector.sh 2311 ${expected}`]);
  }
});

test("parseVector splits on the first equals, keeps the last write, and normalizes nothing", () => {
  const parsed = parseVector("a=1\nb=x=y\nnoise\na=2");
  assert.equal(parsed.size, 2);
  assert.equal(parsed.get("a"), "2");
  assert.equal(parsed.get("b"), "x=y");

  assert.equal(parseVector("k=").get("k"), "");
  assert.equal(parseVector("a=1\r\nb=2").get("a"), "1\r");
});
