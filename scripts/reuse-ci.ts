import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CI_JOBS = [
  "Core typecheck",
  ...Array.from({ length: 5 }, (_, i) => `Core tests (${i + 1}/5)`),
  "Core",
  "CLI",
  "Lint",
  "Production dependency audit",
  "Core Postgres tests",
  "Admin plugin",
  "Web UI plugin",
  "Auth plugin",
  "Portal plugin",
  "Co-author trailers",
];
const success = (item: any) => item?.status === "completed" && item.conclusion === "success";
const sha = (value: unknown) => assert.match(String(value), /^[a-f0-9]{40}$/);
const workflow = ".github/workflows/cicd.yml";
const codeql = "dynamic/github-code-scanning/codeql";

type Api = (path: string) => Promise<any>;

export function readReceipt(log: string) {
  const receipts = [...log.matchAll(/^\S+ QM_CI_TREE=(\{[^\r\n]+\})\r?$/gm)];
  assert.equal(receipts.length, 1);
  const proof = JSON.parse(receipts[0]![1]!);
  sha(proof.sha);
  sha(proof.tree);
  assert.ok(Number.isSafeInteger(proof.runId) && Number.isSafeInteger(proof.attempt));
  return proof;
}

export async function reusableCi(
  api: Api,
  log: (id: number) => Promise<string>,
  repository: string,
  release: string,
  now = Date.now(),
) {
  sha(release);
  const commit = await api(`commits/${release}`);
  if (commit.parents.length !== 1) return;
  const base = commit.parents[0].sha;
  const pulls = await api(`commits/${release}/pulls?per_page=100`);
  const matches = pulls.filter((pull: any) => pull.merged_at && pull.merge_commit_sha === release);
  if (matches.length !== 1) return;
  const pull = await api(`pulls/${matches[0].number}`);
  if (
    !pull.merged ||
    pull.state !== "closed" ||
    pull.merge_commit_sha !== release ||
    pull.base.ref !== "main" ||
    pull.head.repo?.full_name !== repository ||
    pull.base.repo?.full_name !== repository
  )
    return;
  sha(pull.head.sha);
  for (const path of [workflow, "scripts/reuse-ci.ts"]) {
    const [before, after] = await Promise.all([base, release].map((ref) => api(`contents/${path}?ref=${ref}`)));
    if (before.type !== "file" || before.sha !== after.sha) return;
  }
  const page = await api(`actions/workflows/cicd.yml/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`);
  if (page.total_count > 100) return;
  const run = page.workflow_runs
    .filter((run: any) => run.head_branch === pull.head.ref)
    .sort((a: any, b: any) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
  if (
    !run ||
    !success(run) ||
    run.event !== "pull_request" ||
    run.path !== workflow ||
    run.head_sha !== pull.head.sha ||
    run.head_repository?.full_name !== repository ||
    run.repository?.full_name !== repository ||
    !Number.isSafeInteger(run.id) ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1
  )
    return;
  const age = now - Date.parse(run.created_at);
  if (!Number.isFinite(age) || age < 0 || age > 24 * 60 * 60_000) return;
  const jobs = await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  if (jobs.total_count > 100) return;
  for (const name of [...CI_JOBS, "Certify tested tree"]) {
    const matches = jobs.jobs.filter((job: any) => job.name === name);
    if (
      matches.length !== 1 ||
      !success(matches[0]) ||
      matches[0].run_id !== run.id ||
      matches[0].run_attempt !== run.run_attempt ||
      matches[0].head_sha !== run.head_sha
    )
      return;
  }
  const receiptJob = jobs.jobs.find((job: any) => job.name === "Certify tested tree");
  for (const name of ["Validate receipt eligibility", "Checkout tested commit", "Record the immutable tested tree"]) {
    const steps = receiptJob.steps.filter((step: any) => step.name === name);
    if (steps.length !== 1 || !success(steps[0])) return;
  }
  assert.ok(Number.isSafeInteger(receiptJob.id));
  const receipt = readReceipt(await log(receiptJob.id));
  if (receipt.runId !== run.id || receipt.attempt !== run.run_attempt || receipt.pr !== pull.number) return;
  const tested = await api(`commits/${receipt.sha}`);
  if (
    tested.sha !== receipt.sha ||
    tested.commit.tree.sha !== receipt.tree ||
    tested.commit.tree.sha !== commit.commit.tree.sha ||
    tested.parents.length !== 2 ||
    tested.parents[0].sha !== base ||
    tested.parents[1].sha !== pull.head.sha
  )
    return;
  const scans = await api(`actions/runs?event=dynamic&head_sha=${pull.head.sha}&per_page=100`);
  if (scans.total_count > 100) return;
  const scan = scans.workflow_runs
    .filter((scan: any) => scan.path === codeql && scan.head_branch === `refs/pull/${pull.number}/head`)
    .sort((a: any, b: any) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
  if (
    !scan ||
    !success(scan) ||
    scan.head_sha !== pull.head.sha ||
    scan.repository?.full_name !== repository ||
    !Number.isSafeInteger(scan.id) ||
    !Number.isSafeInteger(scan.run_attempt)
  )
    return;
  const fresh = await api(`actions/runs/${run.id}`);
  if (!success(fresh) || fresh.run_attempt !== run.run_attempt || fresh.head_sha !== run.head_sha) return;
  return {
    sha: release,
    tree: tested.commit.tree.sha,
    pr: pull.number,
    testedSha: tested.sha,
    ci: { runId: run.id, attempt: run.run_attempt },
    codeql: { runId: scan.id, attempt: scan.run_attempt },
  };
}

async function main() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
  assert.ok(GITHUB_REPOSITORY && GITHUB_SHA && GITHUB_TOKEN && GITHUB_OUTPUT);
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const url = (path: string) => `https://api.github.com/repos/${GITHUB_REPOSITORY}/${path}`;
  let proof;
  try {
    proof = await reusableCi(
      async (path) => {
        const response = await fetch(url(path), {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`CI provenance unavailable (${response.status})`);
        return response.json();
      },
      async (id) => {
        const redirect = await fetch(url(`actions/jobs/${id}/logs`), {
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(redirect.status, 302);
        const location = new URL(redirect.headers.get("location")!);
        assert.equal(location.protocol, "https:");
        const response = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(15_000) });
        assert.ok(response.ok && response.body);
        let text = "";
        for await (const chunk of response.body) {
          text += Buffer.from(chunk).toString("utf8");
          assert.ok(text.length < 128 * 1024);
        }
        return text;
      },
      GITHUB_REPOSITORY,
      GITHUB_SHA,
    );
  } catch (error) {
    console.log(`No reusable CI proof: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (proof) console.log(`QM_CI_REUSE=${JSON.stringify(proof)}`);
  appendFileSync(GITHUB_OUTPUT, `reusable=${Boolean(proof)}\n`);
  if (GITHUB_STEP_SUMMARY)
    appendFileSync(
      GITHUB_STEP_SUMMARY,
      proof
        ? `Reusing full CI from https://github.com/${GITHUB_REPOSITORY}/actions/runs/${proof.ci.runId}/attempts/${proof.ci.attempt} for identical tree ${proof.tree}.\n`
        : "No exact trusted PR tree proof; running full CI.\n",
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
