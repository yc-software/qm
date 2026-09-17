#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

function report(status, details = {}) {
  console.log(JSON.stringify({ status, ...details }));
}

function stop(status, exitCode = 1, details = {}) {
  report(status, { ...details, exitCode });
  process.exit(exitCode);
}

let options;
try {
  options = parseArgs({
    options: Object.fromEntries(
      [
        "repo",
        "pr",
        "head",
        "timeout-ms",
        "poll-ms",
        "request-timeout-ms",
        "max-retries",
        "backoff-ms",
        "max-backoff-ms",
      ].map((name) => [name, { type: "string" }]),
    ),
  }).values;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo ?? "") ||
    !/^[1-9]\d*$/.test(options.pr ?? "") ||
    !/^[a-fA-F0-9]{40}$/.test(options.head ?? "")
  ) {
    throw new Error("invalid target");
  }
} catch {
  stop("invalid_arguments", 2);
}

function integer(name, fallback, minimum = 1) {
  const value = options[name] === undefined ? fallback : Number(options[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > 2147483647) {
    stop("invalid_arguments", 2, { option: name });
  }
  return value;
}

const timeoutMs = integer("timeout-ms", 1800000);
const pollMs = integer("poll-ms", 15000);
const requestTimeoutMs = integer("request-timeout-ms", 30000);
const maxRetries = integer("max-retries", 5, 0);
const backoffMs = integer("backoff-ms", 1000);
const maxBackoffMs = integer("max-backoff-ms", 15000);
const deadline = performance.now() + timeoutMs;
const expectedHead = options.head.toLowerCase();
let retries = 0;

function remaining() {
  const left = Math.floor(deadline - performance.now());
  if (left <= 0) stop("deadline_exceeded", 124);
  return left;
}

async function pause(ms) {
  await sleep(Math.min(ms, remaining()));
  remaining();
}

function classify(result) {
  const text = result.stderr ?? "";
  if (/\bHTTP\s*429\b|API rate limit exceeded|secondary rate limit|abuse detection/i.test(text)) return "rate_limited";
  if (
    result.status === 4 ||
    /\bHTTP\s*(?:401|403)\b|\b(?:unauthorized|forbidden|authentication failed|bad credentials|requires authentication|not logged in)\b|gh auth login|resource not accessible|could not resolve to a repository/i.test(
      text,
    )
  )
    return "auth_error";
  if (
    result.error?.code === "ETIMEDOUT" ||
    /TLS handshake timeout|\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|connection reset|connection refused|network is unreachable|network error|error connecting to|could not resolve host|no such host|socket hang up|Client\.Timeout exceeded|i\/o timeout|context deadline exceeded|request timed out|connection timed out|temporary failure in name resolution|unexpected EOF|\bHTTP\s*5\d\d\b|\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/i.test(
      text,
    )
  )
    return "transport_error";
  return "unknown_error";
}

async function snapshot(operation) {
  const fields = operation === "view" ? "headRefOid" : "bucket,name";
  for (;;) {
    const result = spawnSync("gh", ["pr", operation, options.pr, "--repo", options.repo, "--json", fields], {
      encoding: "utf8",
      timeout: Math.min(requestTimeoutMs, remaining()),
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "", DEBUG: "" },
    });
    remaining();
    const documentedCheckExit = operation === "checks" && (result.status === 1 || result.status === 8);
    if (!result.error && !result.signal && (result.status === 0 || documentedCheckExit)) {
      try {
        const value = JSON.parse(result.stdout);
        if (
          result.status === 0 ||
          (Array.isArray(value) &&
            value.length > 0 &&
            value.every((check) => check && typeof check.name === "string" && typeof check.bucket === "string") &&
            (result.status === 1
              ? value.some((check) => check.bucket === "fail")
              : value.some((check) => check.bucket === "pending")))
        ) {
          return { value, exitCode: result.status };
        }
      } catch {
        if (result.status === 0) stop("unknown_error", 1, { operation, reason: "invalid_json" });
      }
    }
    const category = classify(result);
    const ghExitCode = result.status ?? 1;
    if (category !== "transport_error") stop(category, ghExitCode || 1, { operation, ghExitCode });
    if (retries >= maxRetries) stop("retries_exhausted", ghExitCode || 1, { operation, category, retries });
    retries += 1;
    const delayMs = Math.min(maxBackoffMs, backoffMs * 2 ** Math.min(retries - 1, 30));
    report("retrying", { operation, category, retry: retries, delayMs, ghExitCode });
    await pause(delayMs);
  }
}

async function verifyHead() {
  const { value } = await snapshot("view");
  if (!value || typeof value.headRefOid !== "string" || !/^[a-fA-F0-9]{40}$/.test(value.headRefOid))
    stop("unknown_error", 1, { operation: "view", reason: "invalid_head" });
  if (value.headRefOid.toLowerCase() !== expectedHead) stop("head_changed", 1);
}

for (;;) {
  await verifyHead();
  const { value: checks, exitCode } = await snapshot("checks");
  if (
    !Array.isArray(checks) ||
    !checks.every(
      (check) =>
        check &&
        typeof check.name === "string" &&
        ["pass", "fail", "pending", "skipping", "cancel"].includes(check.bucket),
    )
  )
    stop("unknown_error", exitCode || 1, { operation: "checks", reason: "invalid_checks" });
  if (checks.length === 0) stop("blocked", 1, { reason: "empty_checks" });
  const counts = Object.fromEntries(
    ["pass", "fail", "pending", "skipping", "cancel"].map((bucket) => [
      bucket,
      checks.filter((check) => check.bucket === bucket).length,
    ]),
  );
  if (counts.fail) stop("failed", exitCode || 1, { counts });
  if (counts.skipping || counts.cancel) stop("blocked", 1, { reason: "non_passing_checks", counts });
  if (counts.pending) {
    report("pending", { counts });
    await pause(pollMs);
    continue;
  }
  await verifyHead();
  remaining();
  stop("success", 0, { head: expectedHead, counts });
}
