import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scrubGitRemotesScript } from "../src/credentials/git-remote-scrub.ts";

test("the scrub strips userinfo from http remote and push URLs under the workspace and leaves ssh remotes alone", () => {
  const root = mkdtempSync(join(tmpdir(), "scrub-"));
  const repo = join(root, "a/b/c/r");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", repo]);
  git("remote", "add", "origin", "https://x-access-token:synthetic-secret@github.com/o/r.git");
  git("remote", "add", "ssh", "ssh://git@github.com/o/r.git");
  git("remote", "set-url", "--add", "--push", "origin", "https://u:synthetic-secret@example.com/o/r@x.git");
  execFileSync("sh", ["-c", scrubGitRemotesScript(root)]);
  assert.ok(!readFileSync(join(repo, ".git/config"), "utf8").includes("synthetic-secret"));
  assert.equal(git("remote", "get-url", "origin"), "https://github.com/o/r.git");
  assert.equal(git("remote", "get-url", "ssh"), "ssh://git@github.com/o/r.git");
});
