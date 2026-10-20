import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CI_JOBS, readReceipt, reusableCi } from "../scripts/reuse-ci.ts";

const repository = "example/qm";
const release = "a".repeat(40),
  head = "b".repeat(40),
  base = "c".repeat(40),
  tested = "d".repeat(40),
  tree = "e".repeat(40);
const now = Date.parse("2026-09-01T12:00:00Z");
const success = { status: "completed", conclusion: "success" };
function fixture() {
  const pull = {
    number: 7,
    merged: true,
    state: "closed",
    merged_at: "today",
    merge_commit_sha: release,
    head: { sha: head, ref: "web-fix", repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
  };
  const run = {
    ...success,
    id: 10,
    run_attempt: 2,
    run_number: 20,
    head_sha: head,
    head_branch: "web-fix",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    path: ".github/workflows/cicd.yml",
    event: "pull_request",
    created_at: new Date(now - 3600_000).toISOString(),
  };
  const scan = {
    ...success,
    id: 30,
    run_attempt: 1,
    run_number: 5,
    head_sha: head,
    head_branch: "refs/pull/7/head",
    path: "dynamic/github-code-scanning/codeql",
    repository: { full_name: repository },
  };
  const jobs = [...CI_JOBS, "Certify tested tree"].map((name, index) => ({
    ...success,
    id: index + 100,
    name,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: head,
    steps: ["Validate receipt eligibility", "Checkout tested commit", "Record the immutable tested tree"].map(
      (name) => ({ ...success, name }),
    ),
  }));
  const receipt = { sha: tested, tree, runId: run.id, attempt: run.run_attempt, pr: pull.number };
  const data: Record<string, any> = {
    [`commits/${release}`]: { sha: release, parents: [{ sha: base }], commit: { tree: { sha: tree } } },
    [`commits/${release}/pulls?per_page=100`]: [pull],
    [`pulls/${pull.number}`]: pull,
    [`contents/.github/workflows/cicd.yml?ref=${base}`]: { type: "file", sha: "f".repeat(40) },
    [`contents/.github/workflows/cicd.yml?ref=${release}`]: { type: "file", sha: "f".repeat(40) },
    [`contents/scripts/reuse-ci.ts?ref=${base}`]: { type: "file", sha: "9".repeat(40) },
    [`contents/scripts/reuse-ci.ts?ref=${release}`]: { type: "file", sha: "9".repeat(40) },
    [`actions/runs?event=dynamic&head_sha=${head}&per_page=100`]: { total_count: 1, workflow_runs: [scan] },
    [`actions/workflows/cicd.yml/runs?event=pull_request&head_sha=${head}&per_page=100`]: {
      total_count: 1,
      workflow_runs: [run],
    },
    [`actions/runs/10/attempts/2/jobs?per_page=100`]: { total_count: jobs.length, jobs },
    [`commits/${tested}`]: { sha: tested, parents: [{ sha: base }, { sha: head }], commit: { tree: { sha: tree } } },
    [`actions/runs/10`]: structuredClone(run),
  };
  return {
    data,
    pull,
    run,
    scan,
    jobs,
    receipt,
    async resolve() {
      return reusableCi(
        async (path) => {
          assert.ok(data[path], path);
          return data[path];
        },
        async (id) => {
          assert.equal(id, jobs.at(-1)!.id);
          return `2026-09-01T11:00:00Z QM_CI_TREE=${JSON.stringify(receipt)}\n`;
        },
        repository,
        release,
        now,
      );
    },
  };
}

test("reuses the full tested merge tree, not the PR head SHA or an artifact name", async () => {
  assert.deepEqual(await fixture().resolve(), {
    sha: release,
    tree,
    pr: 7,
    testedSha: tested,
    ci: { runId: 10, attempt: 2 },
    codeql: { runId: 30, attempt: 1 },
  });
});

test("changed bases, trees, workflow, producer identity, attempts and missing gates cannot reuse", async () => {
  for (const change of [
    (f: any) => {
      f.data[`commits/${release}`].parents.push({ sha: head });
    },
    (f: any) => {
      f.data[`commits/${release}/pulls?per_page=100`] = [];
    },
    (f: any) => {
      f.data[`commits/${release}/pulls?per_page=100`].push(f.pull);
    },
    (f: any) => {
      f.pull.merged = false;
    },
    (f: any) => {
      f.pull.head.repo.full_name = "fork/qm";
    },
    (f: any) => {
      f.pull.base.ref = "other";
    },
    (f: any) => {
      f.pull.base.repo.full_name = "fork/qm";
    },
    (f: any) => {
      f.data[`contents/.github/workflows/cicd.yml?ref=${release}`].sha = base;
    },
    (f: any) => {
      f.data[`contents/scripts/reuse-ci.ts?ref=${release}`].sha = base;
    },
    (f: any) => {
      f.scan.conclusion = "failure";
    },
    (f: any) => {
      f.scan.head_branch = "refs/pull/8/head";
    },
    (f: any) => {
      f.scan.path = ".github/workflows/fake.yml";
    },
    (f: any) => {
      f.scan.head_sha = release;
    },
    (f: any) => {
      f.scan.repository.full_name = "fork/qm";
    },
    (f: any) => {
      f.data[`actions/runs?event=dynamic&head_sha=${head}&per_page=100`].total_count = 101;
    },
    (f: any) => {
      f.data[`actions/runs?event=dynamic&head_sha=${head}&per_page=100`].workflow_runs.push({
        ...f.scan,
        id: 31,
        run_number: 6,
        conclusion: "failure",
      });
    },
    (f: any) => {
      f.run.conclusion = "failure";
    },
    (f: any) => {
      f.run.event = "push";
    },
    (f: any) => {
      f.run.path = ".github/workflows/fake.yml";
    },
    (f: any) => {
      f.run.head_repository.full_name = "fork/qm";
    },
    (f: any) => {
      f.run.repository.full_name = "fork/qm";
    },
    (f: any) => {
      f.run.head_sha = release;
    },
    (f: any) => {
      f.run.head_branch = "other";
    },
    (f: any) => {
      f.run.created_at = new Date(now - 25 * 3600_000).toISOString();
    },
    (f: any) => {
      f.run.created_at = "invalid";
    },
    (f: any) => {
      f.run.created_at = new Date(now + 1).toISOString();
    },
    (f: any) => {
      f.data[`actions/workflows/cicd.yml/runs?event=pull_request&head_sha=${head}&per_page=100`].total_count = 101;
    },
    (f: any) => {
      f.data["actions/runs/10/attempts/2/jobs?per_page=100"].total_count = 101;
    },
    (f: any) => {
      f.jobs[0].conclusion = "skipped";
    },
    (f: any) => {
      f.jobs[0].run_attempt = 1;
    },
    (f: any) => {
      f.jobs[0].run_id = 11;
    },
    (f: any) => {
      f.jobs[0].head_sha = release;
    },
    (f: any) => {
      f.jobs.splice(1, 1);
    },
    (f: any) => {
      f.jobs.push(f.jobs[0]);
    },
    (f: any) => {
      f.jobs.at(-1).steps.pop();
    },
    (f: any) => {
      f.jobs.at(-1).steps[0].conclusion = "skipped";
    },
    (f: any) => {
      f.receipt.runId++;
    },
    (f: any) => {
      f.receipt.attempt--;
    },
    (f: any) => {
      f.receipt.pr++;
    },
    (f: any) => {
      f.receipt.tree = head;
    },
    (f: any) => {
      f.data[`commits/${tested}`].parents[0].sha = head;
    },
    (f: any) => {
      f.data[`commits/${tested}`].parents[1].sha = release;
    },
    (f: any) => {
      f.data[`commits/${tested}`].commit.tree.sha = head;
    },
    (f: any) => {
      f.data[`commits/${release}`].commit.tree.sha = head;
    },
    (f: any) => {
      f.data["actions/runs/10"].run_attempt++;
    },
    (f: any) => {
      f.data["actions/runs/10"].status = "in_progress";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(await f.resolve(), undefined, change.toString());
  }
});

test("a newer failed run prevents recycling an older green run", async () => {
  const f = fixture();
  f.data[`actions/workflows/cicd.yml/runs?event=pull_request&head_sha=${head}&per_page=100`].workflow_runs.push({
    ...f.run,
    id: 11,
    run_number: 21,
    conclusion: "failure",
  });
  assert.equal(await f.resolve(), undefined);
});

test("receipt parser rejects missing, multiple and malformed job output", () => {
  for (const text of ["", "QM_CI_TREE={}", "timestamp QM_CI_TREE={}", "timestamp QM_CI_TREE=nope"])
    assert.throws(() => readReceipt(text));
  const f = fixture();
  const line = `timestamp QM_CI_TREE=${JSON.stringify(f.receipt)}\n`;
  assert.deepEqual(readReceipt(line), f.receipt);
  assert.throws(() => readReceipt(line + line));
});

const workflow = readFileSync(new URL("../.github/workflows/cicd.yml", import.meta.url), "utf8");
const jobs = Object.fromEntries(
  [...workflow.split("jobs:\n")[1]!.matchAll(/^ {2}([a-z-]+):\n(.*?)(?=^ {2}[a-z-]+:|$(?![\s\S]))/gms)].map(
    (match): [string, string] => [match[1]!, match[2]!],
  ),
);

test("all quality jobs keep successful names and missing proof runs full checks", () => {
  assert.ok(workflow.includes("permissions:\n  contents: read"));
  assert.ok(jobs.core!.includes("if: always() && !cancelled()"));
  assert.ok(jobs.core!.includes('test "$TYPECHECK" = success && test "$TESTS" = success'));
  const names: string[] = [];
  for (const [id, block] of Object.entries(jobs)) {
    if (["reuse", "certify", "notify-deployments"].includes(id)) continue;
    const name = block.match(/^ {4}name: (.+)$/m)![1]!;
    if (id === "core-tests") names.push(...[1, 2, 3, 4, 5].map((n) => name.replace("${{ matrix.shard }}", String(n))));
    else names.push(name);
    if (["core", "coauthor-trailers", "dependency-audit"].includes(id)) continue;
    assert.ok(block.includes("needs: reuse\n    if: always() && !cancelled()"));
    const steps = block.split(/(?=^ {6}- (?:name|uses):)/m).slice(1);
    assert.ok(steps[0]!.includes("if: needs.reuse.outputs.reusable == 'true'"));
    for (const step of steps.slice(1)) assert.ok(step.includes("if: needs.reuse.outputs.reusable != 'true'"));
  }
  assert.deepEqual(names.sort(), [...CI_JOBS].sort());
  assert.ok(jobs.reuse!.includes("continue-on-error: true"));
  assert.ok(jobs.reuse!.includes("steps.proof.outcome == 'success' && steps.proof.outputs.reusable == 'true'"));
  assert.ok(jobs.reuse!.includes("if: github.event_name == 'push' && github.ref == 'refs/heads/main'"));
});

test("deployment notice fires only for a fully green main push and holds no repository access", () => {
  const job = jobs["notify-deployments"]!;
  assert.ok(
    job.includes("if: always() && !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main'"),
  );
  assert.ok(
    job.includes(
      "needs: [core, cli, lint, dependency-audit, core-postgres, admin-plugin, web-ui-plugin, auth-plugin, portal-plugin]",
    ),
  );
  assert.ok(job.includes("permissions: {}"));
  assert.ok(job.includes("continue-on-error: true"));
  assert.ok(!job.includes("exit 1"));
  assert.ok(job.includes(`all(. == "success")`));
  assert.equal([...job.matchAll(/^ {6}- /gm)].length, 1);
  assert.ok(!job.includes("uses: actions/checkout"));
});

test("receipt is an isolated immutable checkout with no secrets, artifacts, caches or repository scripts", () => {
  const job = jobs.certify!;
  assert.ok(job.includes("continue-on-error: true"));
  assert.ok(job.includes("github.event_name == 'pull_request'"));
  assert.ok(job.includes("PR_REPOSITORY_ID: ${{ github.event.pull_request.head.repo.id }}"));
  assert.ok(job.includes('test "$PR_REPOSITORY_ID" = "$GITHUB_REPOSITORY_ID"'));
  assert.ok(job.includes('if (checks[id]?.result !== "success") throw new Error'));
  assert.ok(job.includes("always() && !cancelled()"));
  assert.ok(job.includes("permissions:\n      contents: read"));
  assert.ok(
    job.includes(
      "needs: [core, cli, lint, core-postgres, admin-plugin, web-ui-plugin, auth-plugin, portal-plugin, coauthor-trailers]",
    ),
  );
  assert.equal([...job.matchAll(/^ {6}- /gm)].length, 3);
  assert.ok(job.includes("ref: ${{ github.sha }}\n          persist-credentials: false"));
  assert.match(job, /uses: actions\/checkout@[a-f0-9]{40}/);
  assert.ok(job.includes('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'));
  assert.ok(job.includes("QM_CI_TREE="));
  assert.doesNotMatch(job, /secrets\.|npm |scripts\/|artifact|cache|id-token/);
});

test("inline receipt eligibility rejects missing or failed prerequisites, not an unrelated skipped resolver", () => {
  const script = jobs
    .certify!.split("      - name: Validate receipt eligibility")[1]!
    .split("      - name: Checkout tested commit")[0]!
    .split("        run: |\n")[1]!
    .replace(/^ {10}/gm, "");
  const ids = [
    "core",
    "cli",
    "lint",
    "core-postgres",
    "admin-plugin",
    "web-ui-plugin",
    "auth-plugin",
    "portal-plugin",
    "coauthor-trailers",
  ];
  const checks = Object.fromEntries(ids.map((id) => [id, { result: "success" }]));
  checks.reuse = { result: "skipped" };
  const execute = (source = "123", target = "123") =>
    spawnSync("bash", ["-eo", "pipefail", "-c", script], {
      env: { ...process.env, PR_REPOSITORY_ID: source, GITHUB_REPOSITORY_ID: target, CHECKS: JSON.stringify(checks) },
      encoding: "utf8",
    });
  assert.equal(execute().status, 0);
  for (const [source, target] of [
    ["123", "456"],
    ["", "123"],
    ["", ""],
    ["123", ""],
  ])
    assert.notEqual(execute(source, target).status, 0, `${source}/${target}`);
  for (const id of ids) {
    checks[id] = { result: "failure" };
    assert.notEqual(execute().status, 0, id);
    delete checks[id];
    assert.notEqual(execute().status, 0, id);
    checks[id] = { result: "success" };
  }
});
