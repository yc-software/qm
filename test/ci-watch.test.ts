import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const head = "a".repeat(40);
const watcher = fileURLToPath(new URL("../skills-seed/github-gitlab/scripts/watch-ci.mjs", import.meta.url));
const view = { operation: "view", json: { headRefOid: head } };
const pass = { operation: "checks", json: [{ name: "CI", bucket: "pass" }] };
const pending = { operation: "checks", json: [{ name: "CI", bucket: "pending" }], code: 8 };
type Step = { operation: string; json?: unknown; stdout?: string; stderr?: string; code?: number; hang?: boolean };

function run(steps: Step[], args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "ci-watch-"));
  writeFileSync(join(dir, "steps.json"), JSON.stringify(steps));
  writeFileSync(
    join(dir, "gh"),
    `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
const dir = process.env.FAKE_GH_DIR;
const indexFile = dir + '/index';
const index = existsSync(indexFile) ? Number(readFileSync(indexFile, 'utf8')) : 0;
const steps = JSON.parse(readFileSync(dir + '/steps.json', 'utf8'));
const step = steps[index];
appendFileSync(dir + '/calls', JSON.stringify(process.argv.slice(2)) + '\\n');
writeFileSync(indexFile, String(index + 1));
if (!step || step.operation !== process.argv[3]) process.exit(99);
if (step.hang) {
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(step.stdout ?? JSON.stringify(step.json ?? null));
  process.stderr.write(step.stderr ?? '');
  process.exitCode = step.code ?? 0;
}
`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        watcher,
        "--repo",
        "owner/repo",
        "--pr",
        "42",
        "--head",
        head,
        "--timeout-ms",
        "4000",
        "--poll-ms",
        "1",
        "--request-timeout-ms",
        "1000",
        "--backoff-ms",
        "1",
        "--max-backoff-ms",
        "2",
        "--max-retries",
        "2",
        ...args,
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH}`,
          FAKE_GH_DIR: dir,
          GH_TOKEN: "secret-must-not-appear",
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes("secret-must-not-appear"));
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const calls = readFileSync(join(dir, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const call of calls)
      assert.deepEqual(call, [
        "pr",
        call[1],
        "42",
        "--repo",
        "owner/repo",
        "--json",
        call[1] === "view" ? "headRefOid" : "bucket,name",
      ]);
    assert.equal(lines.at(-1).exitCode, result.status);
    return { code: result.status, lines, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const stderr of [
  "net/http: TLS handshake timeout",
  "read: connection reset by peer",
  "HTTP 502: Bad Gateway",
  "error connecting to api.github.com",
]) {
  test(`recovers from ${stderr} inside one watcher process`, () => {
    const result = run([view, { operation: "checks", stderr, code: 1 }, pass, view]);
    assert.equal(result.code, 0);
    assert.deepEqual(
      result.lines.map((line) => line.status),
      ["retrying", "success"],
    );
  });
}

test("pending exit 8 and exit 0 poll until a complete passing snapshot", () => {
  const result = run([view, pending, view, { ...pending, code: 0 }, view, pass, view]);
  assert.equal(result.code, 0);
  assert.deepEqual(
    result.lines.map((line) => line.status),
    ["pending", "pending", "success"],
  );
  assert.equal(result.calls.length, 7);
});

test("transport errors exhaust the bounded retry budget", () => {
  const error = { operation: "checks", stderr: "TLS handshake timeout", code: 1 };
  const result = run([view, error, error, error]);
  assert.equal(result.code, 1);
  assert.deepEqual(
    result.lines.map((line) => line.status),
    ["retrying", "retrying", "retries_exhausted"],
  );
});

test("real failed checks stop immediately, including mixed pending checks", () => {
  const result = run([view, { operation: "checks", json: [{ name: "CI", bucket: "fail" }, ...pending.json], code: 1 }]);
  assert.equal(result.code, 1);
  assert.equal(result.lines.at(-1).status, "failed");
  assert.equal(result.calls.length, 2);
});

for (const stderr of [
  "HTTP 401: Bad credentials",
  "HTTP 403: Resource not accessible by integration",
  "To get started with GitHub CLI, please run: gh auth login",
]) {
  test(`auth failure does not retry: ${stderr}`, () => {
    const code = stderr.includes("gh auth login") ? 4 : 1;
    const result = run([{ operation: "view", stderr: `${stderr} secret-must-not-appear`, code }]);
    assert.equal(result.code, code);
    assert.equal(result.lines.at(-1).status, "auth_error");
    assert.equal(result.calls.length, 1);
  });
}

for (const stderr of [
  "HTTP 403: API rate limit exceeded",
  "HTTP 403: You have exceeded a secondary rate limit",
  "HTTP 403: You have triggered an abuse detection mechanism",
  "HTTP 429: Too Many Requests",
]) {
  test(`rate limits stop without auth errors or retries: ${stderr}`, () => {
    const result = run([view, { operation: "checks", stderr, code: 1 }]);
    assert.equal(result.code, 1);
    assert.deepEqual(
      result.lines.map((line) => line.status),
      ["rate_limited"],
    );
    assert.equal(result.lines.at(-1).ghExitCode, 1);
    assert.equal(result.calls.length, 2);
  });
}

test("unknown exit code propagates and valid-looking partial output cannot pass", () => {
  const result = run([view, { ...pass, code: 42, stderr: "unknown error secret-must-not-appear" }]);
  assert.equal(result.code, 42);
  assert.equal(result.lines.at(-1).status, "unknown_error");
});

for (const step of [
  { ...pass, code: 1 },
  { ...pass, code: 8 },
  { operation: "checks", stdout: '[{"name":"CI","bucket":"pass"}', code: 0 },
  { operation: "checks", json: [{ name: "CI", bucket: "unexpected" }] },
]) {
  test(`fails closed on invalid checks or inconsistent exit: ${JSON.stringify(step)}`, () => {
    const result = run([view, step]);
    assert.notEqual(result.code, 0);
    assert.equal(result.lines.at(-1).status, "unknown_error");
  });
}

for (const checks of [[], [{ name: "CI", bucket: "skipping" }], [{ name: "CI", bucket: "cancel" }]]) {
  test(`blocks empty or nonpassing checks: ${JSON.stringify(checks)}`, () => {
    const result = run([view, { operation: "checks", json: checks }]);
    assert.equal(result.code, 1);
    assert.equal(result.lines.at(-1).status, "blocked");
  });
}

for (const steps of [
  [{ operation: "view", json: { headRefOid: "b".repeat(40) } }],
  [view, pass, { operation: "view", json: { headRefOid: "b".repeat(40) } }],
  [view, pending, { operation: "view", json: { headRefOid: "b".repeat(40) } }],
]) {
  test(`head changes stop before success at invocation ${steps.length}`, () => {
    const result = run(steps);
    assert.equal(result.code, 1);
    assert.equal(result.lines.at(-1).status, "head_changed");
  });
}

test("overall deadline kills a hung gh request", () => {
  const started = performance.now();
  const result = run([{ operation: "view", hang: true }], ["--timeout-ms", "200"]);
  assert.equal(result.code, 124);
  assert.equal(result.lines.at(-1).status, "deadline_exceeded");
  assert.ok(performance.now() - started < 2000);
});

test("a request timeout retries within the overall deadline", () => {
  const result = run([{ operation: "view", hang: true }, view, pass, view], ["--request-timeout-ms", "200"]);
  assert.equal(result.code, 0);
  assert.deepEqual(
    result.lines.map((line) => line.status),
    ["retrying", "success"],
  );
});

test("pending sleep and retry backoff cannot exceed the overall deadline", () => {
  for (const steps of [[view, pending], [{ operation: "view", code: 1, stderr: "TLS handshake timeout" }]]) {
    const result = run(steps, [
      "--timeout-ms",
      "300",
      "--poll-ms",
      "10000",
      "--backoff-ms",
      "10000",
      "--max-backoff-ms",
      "10000",
    ]);
    assert.equal(result.code, 124);
    assert.equal(result.lines.at(-1).status, "deadline_exceeded");
  }
});
