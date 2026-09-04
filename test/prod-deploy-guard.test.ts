import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const guardScript = resolve("scripts/prod-deploy-guard.sh");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function commit(cwd: string, message: string): string {
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test User", "commit", "--allow-empty", "-m", message],
    { cwd, stdio: "ignore" },
  );
  return git(cwd, ["rev-parse", "HEAD"]);
}

function setupRepo(): { repo: string; firstSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "prod-deploy-guard-"));
  const remote = join(dir, "remote.git");
  const repo = join(dir, "repo");

  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  git(repo, ["branch", "-M", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  writeFileSync(join(repo, "README.md"), "test\n");
  const firstSha = commit(repo, "first");
  git(repo, ["push", "-u", "origin", "main"]);

  return { repo, firstSha };
}

function commitFile(cwd: string, rel: string, message: string): string {
  mkdirSync(join(cwd, dirname(rel)), { recursive: true });
  writeFileSync(join(cwd, rel), `${message}\n`);
  execFileSync("git", ["add", rel], { cwd, stdio: "ignore" });
  return commit(cwd, message);
}

function runGuard(
  repo: string,
  sha: string,
  paths?: string,
  deployedSha?: string,
): { output: string; shouldDeploy: string } {
  const githubOutput = join(repo, "github-output.txt");
  const output = execFileSync("bash", [guardScript], {
    cwd: repo,
    env: {
      ...process.env,
      GITHUB_SHA: sha,
      GITHUB_OUTPUT: githubOutput,
      ...(paths ? { PROD_DEPLOY_GUARD_PATHS: paths } : {}),
      ...(deployedSha === undefined ? {} : { PROD_DEPLOY_GUARD_DEPLOYED_SHA: deployedSha }),
    },
    encoding: "utf8",
  });
  const shouldDeploy = readFileSync(githubOutput, "utf8").trim().split("=").at(-1);
  assert.ok(shouldDeploy);
  return { output, shouldDeploy };
}

test("prod deploy guard continues when the run SHA is origin/main", () => {
  const { repo, firstSha } = setupRepo();

  const result = runGuard(repo, firstSha);

  assert.equal(result.shouldDeploy, "true");
  assert.match(result.output, /continuing with prod deploy/);
});

test("prod deploy guard skips successfully when a newer main push exists", () => {
  const { repo, firstSha } = setupRepo();
  commit(repo, "second");
  git(repo, ["push", "origin", "main"]);

  const result = runGuard(repo, firstSha);

  assert.equal(result.shouldDeploy, "false");
  assert.match(result.output, /Skipping prod deploy/);
});

test("path-scoped: a newer main commit off the paths does not skip the deploy", () => {
  const { repo } = setupRepo();
  const flySha = commitFile(repo, "fly/tools/engine.py", "engine change");
  commitFile(repo, "src/other.ts", "unrelated core change");
  git(repo, ["push", "origin", "main"]);

  const result = runGuard(repo, flySha, "fly deploy/sandbox/fly.toml");

  assert.equal(result.shouldDeploy, "true");
  assert.match(result.output, /continuing with prod deploy/);
});

test("path-scoped: a newer main commit ON the paths skips (its own run will deploy)", () => {
  const { repo } = setupRepo();
  const oldEngine = commitFile(repo, "fly/tools/engine.py", "engine change 1");
  commitFile(repo, "fly/tools/engine.py", "engine change 2");
  git(repo, ["push", "origin", "main"]);

  const result = runGuard(repo, oldEngine, "fly deploy/sandbox/fly.toml");

  assert.equal(result.shouldDeploy, "false");
  assert.match(result.output, /Skipping prod deploy/);
});

test("path-scoped: a directory path includes changes in nested descendants", () => {
  const { repo } = setupRepo();
  const oldPlugin = commitFile(repo, "plugins/example/src/index.ts", "plugin change 1");
  commitFile(repo, "plugins/example/src/nested/helper.ts", "plugin change 2");
  git(repo, ["push", "origin", "main"]);

  const result = runGuard(repo, oldPlugin, "plugins/example/src");

  assert.equal(result.shouldDeploy, "false");
  assert.match(result.output, /Skipping prod deploy/);
});

test("path-scoped: deploys when the run SHA is head of main", () => {
  const { repo } = setupRepo();
  const flySha = commitFile(repo, "fly/tools/engine.py", "engine change");
  git(repo, ["push", "origin", "main"]);

  const result = runGuard(repo, flySha, "fly deploy/sandbox/fly.toml");

  assert.equal(result.shouldDeploy, "true");
});

test("path-scoped: no path-touching commit at all still deploys", () => {
  const { repo, firstSha } = setupRepo();

  const result = runGuard(repo, firstSha, "fly deploy/sandbox/fly.toml");

  assert.equal(result.shouldDeploy, "true");
});

test("deployed-mode: a commit behind the branch tip still deploys when it is ahead of live", () => {
  const { repo, firstSha } = setupRepo();
  const mine = commit(repo, "my change");
  commit(repo, "someone else's later merge");
  git(repo, ["push", "origin", "main"]);

  assert.equal(runGuard(repo, mine).shouldDeploy, "false");
  const result = runGuard(repo, mine, undefined, firstSha);

  assert.equal(result.shouldDeploy, "true");
  assert.match(result.output, /ahead of the deployed/);
});

test("deployed-mode: an out-of-order older run does not roll the deployment back", () => {
  const { repo, firstSha } = setupRepo();
  const newer = commit(repo, "newer");
  git(repo, ["push", "origin", "main"]);

  const result = runGuard(repo, firstSha, undefined, newer);

  assert.equal(result.shouldDeploy, "false");
  assert.match(result.output, /would roll it back/);
});

test("deployed-mode: redeploying what is already live is skipped", () => {
  const { repo, firstSha } = setupRepo();

  const result = runGuard(repo, firstSha, undefined, firstSha);

  assert.equal(result.shouldDeploy, "false");
  assert.match(result.output, /already what is deployed/);
});

test("deployed-mode: an unknown or empty live SHA does not block the deploy", () => {
  const { repo, firstSha } = setupRepo();
  commit(repo, "second");
  git(repo, ["push", "origin", "main"]);

  const unknown = runGuard(repo, firstSha, undefined, "0".repeat(40));
  assert.equal(unknown.shouldDeploy, "true");
  assert.match(unknown.output, /treating the deployment as unknown/);

  assert.equal(runGuard(repo, firstSha, undefined, "").shouldDeploy, "false");
});

test("deployed-mode: a divergent commit that is not on the branch is not deployed", () => {
  const { repo, firstSha } = setupRepo();
  const onMain = commit(repo, "main moves");
  git(repo, ["push", "origin", "main"]);
  git(repo, ["checkout", "-q", "-b", "side", firstSha]);
  const sideSha = commit(repo, "divergent side commit");

  const result = runGuard(repo, sideSha, undefined, onMain);

  assert.equal(result.shouldDeploy, "false");
  assert.match(result.output, /would roll it back/);
});
