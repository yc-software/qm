import { test } from "node:test";
import assert from "node:assert/strict";
import { carriesGitMetadata, normalizeRelPath } from "../src/deploy/deploy-fs.ts";

test("git metadata names are still caught behind trailing dots or whitespace", () => {
  for (const path of [
    ".git./config",
    ".git  /x",
    "app/.GIT. ./hooks",
    "git~1../config",
    ".git\u00a0/x",
    ".git\u3000/x",
    ".git\ufeff/x",
  ]) {
    assert.equal(carriesGitMetadata(path), true, path);
    assert.throws(() => normalizeRelPath(path), /invalid deploy path/, path);
  }
  for (const path of ["wrap.git/config", ".git-credentials", ".git.x/y", "digit~1/x"]) {
    assert.equal(carriesGitMetadata(path), false, path);
    assert.equal(normalizeRelPath(path), path);
  }
});

test("a path component holding a long run of dots is checked promptly", () => {
  const path = `app/${".".repeat(100_000)}x/index.html`;
  const started = performance.now();
  const carries = carriesGitMetadata(path);
  const normalized = normalizeRelPath(path);
  const elapsedMs = performance.now() - started;
  assert.equal(carries, false);
  assert.equal(normalized, path);
  assert.ok(elapsedMs < 1_000, `git metadata check took ${Math.round(elapsedMs)} ms`);
});
