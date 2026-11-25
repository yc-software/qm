import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scrubGitRemotesScript } from "../src/credentials/git-remote-scrub.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("the scrub strips userinfo from http remotes under the workspace and leaves everything else", (t) => {
  const root = mkdtempSync(join(tmpdir(), "scrub-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const clean = join(root, "clean");
  for (const dir of [repo, clean]) execFileSync("git", ["init", "-q", dir]);
  git(repo, "remote", "add", "origin", "https://x-access-token:synthetic-secret@github.com/o/r.git");
  git(repo, "remote", "set-url", "--push", "origin", "http://synthetic-secret@example.test/o/r.git");
  git(repo, "remote", "add", "ssh", "ssh://git@github.com/o/r.git");
  git(repo, "config", "url.https://u:synthetic-secret@gitlab.com/.insteadOf", "https://gitlab.com/");
  git(clean, "remote", "add", "origin", "https://github.com/o/clean.git");
  const before = readFileSync(join(clean, ".git/config"), "utf8");

  execFileSync("sh", ["-c", scrubGitRemotesScript(root)]);

  assert.ok(!readFileSync(join(repo, ".git/config"), "utf8").includes("synthetic-secret"));
  assert.equal(git(repo, "remote", "get-url", "origin"), "https://github.com/o/r.git");
  assert.equal(git(repo, "remote", "get-url", "--push", "origin"), "http://example.test/o/r.git");
  assert.equal(git(repo, "remote", "get-url", "ssh"), "ssh://git@github.com/o/r.git");
  assert.equal(git(repo, "config", "url.https://gitlab.com/.insteadOf"), "https://gitlab.com/");
  assert.equal(readFileSync(join(clean, ".git/config"), "utf8"), before);
});

test("the scrub succeeds on a workspace with no repositories", () => {
  const root = mkdtempSync(join(tmpdir(), "scrub-empty-"));
  try {
    execFileSync("sh", ["-c", scrubGitRemotesScript(root)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
