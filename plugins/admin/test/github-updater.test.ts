import test from "node:test";
import assert from "node:assert/strict";
import { GitHubResponseError, createGitHubUpdater, githubUpdaterConfig } from "../src/github-updater.ts";

const config = {
  repository: "acme/deploy",
  workflow: "qm-update.yml",
  ref: "main",
  token: "secret",
  apiBaseUrl: "https://github.test",
};
const RUN_URL = "https://github.com/acme/deploy/actions/runs/7";

test("GitHub updater configuration is unavailable without both repository and token", () => {
  assert.equal(githubUpdaterConfig({}), null);
  assert.equal(githubUpdaterConfig({ QM_UPDATE_GITHUB_REPOSITORY: "acme/deploy" }), null);
});

test("GitHub updater dispatches and resolves the matching durable job", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const updater = createGitHubUpdater(config, (async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/dispatches")) {
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/deploy/actions/runs/1" }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        workflow_runs: [
          {
            display_title: "QM update to 0.2.0 [job-1]",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/acme/deploy/actions/runs/1",
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch);
  assert.deepEqual(await updater.dispatch({ id: "job-1", version: "0.2.0", requestedBy: "admin@acme.test" }), {
    state: "queued",
    detail: "Waiting for the deployment runner",
    runUrl: "https://github.com/acme/deploy/actions/runs/1",
  });
  assert.deepEqual(await updater.findRun("job-1"), {
    state: "running",
    detail: "Installing and deploying the update",
    runUrl: "https://github.com/acme/deploy/actions/runs/1",
  });
  assert.equal(calls.length, 2);
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-github-api-version"), "2022-11-28");
});

test("GitHub updater accepts the legacy empty dispatch response", async () => {
  const updater = createGitHubUpdater(config, (async () => new Response(null, { status: 204 })) as typeof fetch);
  assert.equal(await updater.dispatch({ id: "job-1", version: "0.2.0", requestedBy: "admin@acme.test" }), null);
});

test("GitHub updater rejections carry the HTTP status", async () => {
  const updater = createGitHubUpdater(
    config,
    (async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })) as typeof fetch,
  );
  await assert.rejects(
    updater.dispatch({ id: "job-1", version: "0.2.0", requestedBy: "admin@acme.test" }),
    (error: unknown) =>
      error instanceof GitHubResponseError &&
      error.status === 401 &&
      /^GitHub returned 401: .*Bad credentials/.test(error.message),
  );
});

test("GitHub updater resolves a job with a run URL by run id", async () => {
  const calls: string[] = [];
  const updater = createGitHubUpdater(config, (async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ status: "completed", conclusion: "cancelled", html_url: RUN_URL }), {
      status: 200,
    });
  }) as typeof fetch);
  assert.deepEqual(await updater.findRun("job-1", RUN_URL), {
    state: "failed",
    detail: "Workflow cancelled",
    runUrl: RUN_URL,
  });
  assert.deepEqual(calls, ["https://github.test/repos/acme/deploy/actions/runs/7"]);
});

test("GitHub updater fails a job whose run is no longer available", async () => {
  const updater = createGitHubUpdater(
    config,
    (async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })) as typeof fetch,
  );
  assert.deepEqual(await updater.findRun("job-1", RUN_URL), {
    state: "failed",
    detail: "The deployment workflow run is no longer available",
    runUrl: RUN_URL,
  });
});

test("GitHub updater maps listed workflow run states", async () => {
  const listing = (run: Record<string, unknown>) =>
    createGitHubUpdater(
      config,
      (async () =>
        new Response(
          JSON.stringify({
            workflow_runs: [{ display_title: "QM update to 0.2.0 [job-1]", html_url: RUN_URL, ...run }],
          }),
          { status: 200 },
        )) as typeof fetch,
    );
  assert.deepEqual(await listing({ status: "completed", conclusion: "cancelled" }).findRun("job-1"), {
    state: "failed",
    detail: "Workflow cancelled",
    runUrl: RUN_URL,
  });
  assert.deepEqual(await listing({ status: "queued", conclusion: null }).findRun("job-1"), {
    state: "queued",
    detail: "Waiting for the deployment runner",
    runUrl: RUN_URL,
  });
  assert.equal(await listing({ status: "queued", conclusion: null }).findRun("job-2"), null);
});

test("GitHub updater reports API failures while reading runs", async () => {
  const updater = createGitHubUpdater(config, (async () => new Response("boom", { status: 500 })) as typeof fetch);
  await assert.rejects(updater.findRun("job-1"), /could not read the update workflow: GitHub returned 500: boom/);
  await assert.rejects(updater.findRun("job-1", RUN_URL), /could not read the update workflow: GitHub returned 500/);
});
