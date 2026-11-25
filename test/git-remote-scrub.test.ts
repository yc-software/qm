import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scrubGitRemotesScript } from "../src/credentials/git-remote-scrub.ts";

test("the scrub strips userinfo from http remotes under the workspace and leaves ssh remotes alone", () => {
  const root = mkdtempSync(join(tmpdir(), "scrub-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", join(root, "r"), ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", join(root, "r")]);
  git("remote", "add", "origin", "https://x-access-token:synthetic-secret@github.com/o/r.git");
  git("remote", "add", "ssh", "ssh://git@github.com/o/r.git");
  git("config", "url.https://u:synthetic-secret@gitlab.com/.insteadOf", "https://gitlab.com/");
  execFileSync("sh", ["-c", scrubGitRemotesScript(root)]);
  assert.ok(!readFileSync(join(root, "r/.git/config"), "utf8").includes("synthetic-secret"));
  assert.equal(git("remote", "get-url", "origin"), "https://github.com/o/r.git");
  assert.equal(git("remote", "get-url", "ssh"), "ssh://git@github.com/o/r.git");
});
