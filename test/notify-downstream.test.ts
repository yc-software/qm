import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(".github/workflows/notify-downstream.yml", "utf8");
const condition = workflow.match(/ {4}if: >-\n([\s\S]*?) {4}runs-on:/)![1]!;
const script = workflow.match(/ {10}node <<'NODE'\n([\s\S]*?) {10}NODE/)![1]!;
const repository = "example/core";
const ci = {
  path: ".github/workflows/cicd.yml",
  event: "push",
  head_sha: "a".repeat(40),
  head_branch: "main",
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
  actor: { type: "User" },
};
const admitted = (run = ci, enabled = "true", ref = "refs/heads/main") =>
  Function(
    "github",
    "vars",
    `return (${condition})`,
  )({ ref, repository, event: { workflow_run: run } }, { DOWNSTREAM_NOTIFY_ENABLED: enabled });

async function notify(
  options: { token?: string; target?: string; main?: string; ci?: typeof ci | null; response?: number } = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  const process = {
    env: {
      DOWNSTREAM_REPOSITORY: options.target ?? "example/deployment",
      DOWNSTREAM_DISPATCH_TOKEN: options.token ?? "dispatch-token",
      SOURCE_TOKEN: "source-token",
      GITHUB_REPOSITORY: repository,
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_EVENT_PATH: "event.json",
    },
    exitCode: 0,
  };
  await runInNewContext(script, {
    process,
    AbortSignal,
    require: (name: string) => {
      assert.equal(name, "node:fs");
      return { readFileSync: () => JSON.stringify({ workflow_run: ci }) };
    },
    console: { log: (message: string) => logs.push(message), error: (message: string) => logs.push(message) },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      if (url.endsWith("/dispatches")) return new Response(null, { status: options.response ?? 204 });
      return Response.json(
        url.endsWith("git/ref/heads/main")
          ? { object: { sha: options.main ?? ci.head_sha } }
          : { workflow_runs: options.ci === null ? [] : [options.ci ?? ci] },
      );
    },
  });
  return { calls, logs, exitCode: process.exitCode };
}

test("notifier only wakes on configured same-repository main push CI and dynamic CodeQL success", () => {
  assert.ok(admitted());
  assert.ok(admitted({ ...ci, path: "dynamic/github-code-scanning/codeql", event: "dynamic" }));
  assert.equal(admitted(ci, ""), false);
  assert.equal(admitted(ci, "false"), false);
  assert.equal(admitted(ci, "true", "refs/heads/feature"), false);
  for (const patch of [
    { conclusion: "failure" },
    { head_branch: "feature" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { path: ".github/workflows/other.yml" },
    { actor: { type: "Bot" } },
    { head_repository: { full_name: "outsider/core" } },
  ])
    assert.equal(admitted({ ...ci, ...patch }), false);
  assert.match(workflow, /workflows: \[CI\/CD, CodeQL, Push on main\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /permissions:\n {2}contents: read\n {2}actions: read/);
  assert.match(workflow, /secrets.DOWNSTREAM_REPOSITORY/);
  assert.doesNotMatch(workflow, /uses:|checkout|download-artifact|vars.DOWNSTREAM_REPOSITORY|client_payload/);
});

test("notifier separates source-read and downstream tokens and sends only a wakeup", async () => {
  const { calls, logs, exitCode } = await notify();
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 3);
  for (const call of calls.slice(0, 2)) {
    assert.ok(call.url.startsWith(`https://api.github.com/repos/${repository}/`));
    assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer source-token");
  }
  const post = calls[2]!;
  assert.equal(post.url, "https://api.github.com/repos/example/deployment/dispatches");
  assert.equal(post.init.method, "POST");
  assert.equal((post.init.headers as Record<string, string>).Authorization, "Bearer dispatch-token");
  assert.deepEqual(JSON.parse(post.init.body as string), { event_type: "upstream-main-completed" });
  assert.deepEqual(logs, ["Downstream reconciliation notified"]);
});

test("missing configuration, stale main, failed reruns and bots cannot notify", async () => {
  for (const options of [{ target: "" }, { token: "" }]) assert.equal((await notify(options)).calls.length, 0);
  assert.equal((await notify({ main: "b".repeat(40) })).calls.length, 1);
  for (const patch of [
    { conclusion: "failure" },
    { status: "in_progress" },
    { head_branch: "feature" },
    { head_sha: "b".repeat(40) },
    { event: "workflow_dispatch" },
    { actor: { type: "Bot" } },
    { head_repository: { full_name: "outsider/core" } },
    { path: ".github/workflows/other.yml" },
  ])
    assert.equal((await notify({ ci: { ...ci, ...patch } })).calls.length, 2);
  assert.equal((await notify({ ci: null })).calls.length, 2);
  for (const target of ["../deployment", "example/..", "example/deployment/extra", "https://example.com"]) {
    const result = await notify({ target });
    assert.equal(result.exitCode, 1);
    assert.equal(result.calls.length, 0);
  }
  const failed = await notify({ response: 403 });
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failed.logs, ["Downstream notification failed (403)"]);
});
