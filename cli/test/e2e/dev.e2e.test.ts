import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, rmDir, runCli, tmp } from "./harness.ts";

test("normal dev commands delegate to the canonical contributor CLI", () => {
  const result = runCli(["dev", "frobnicate"], { cwd: repoRoot });
  assert.equal(result.code, 2);
  assert.match(result.out, /usage: dev/);
});

test("dev service names map, dedupe, and reject unknown targets before side effects", (t) => {
  const store = tmp("dev-web-ui-log");
  const lock = join(store, "leases", "pool1.lock");
  t.after(() => rmDir(store));
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "meta"), `worktree=${repoRoot}\n`);
  writeFileSync(join(lock, "web.log"), "web ui ready\n");

  const result = runCli(["dev", "logs", "web-ui", "web"], {
    cwd: repoRoot,
    env: { QM_POOL_STORE: store },
  });
  assert.equal(result.code, 0);
  assert.match(result.out, /web ui ready/);
  assert.equal(result.out.match(/web ui ready/g)?.length, 1);

  const unknownLog = runCli(["dev", "logs", "web-ui", "typo"], { cwd: repoRoot, env: { QM_POOL_STORE: store } });
  assert.equal(unknownLog.code, 2);
  assert.match(unknownLog.out, /unknown service "typo"/);

  const invalidRestart = runCli(["dev", "restart", "supervisor"], { cwd: repoRoot, env: { QM_POOL_STORE: store } });
  assert.equal(invalidRestart.code, 2);
  assert.match(invalidRestart.out, /unknown service "supervisor"/);
});

test("delegated dev commands reject extra arguments and irrelevant flags before side effects", () => {
  const extra = runCli(["dev", "down", "garbage"], { cwd: repoRoot });
  assert.equal(extra.code, 2);
  assert.match(extra.out, /unexpected argument: "garbage"/);

  const invalidSurface = runCli(["dev", "up", "--surface", "invalid"], { cwd: repoRoot });
  assert.equal(invalidSurface.code, 2);
  assert.match(invalidSurface.out, /--surface must be web, slack, or both/);

  const conflictingSurface = runCli(["dev", "up", "--surface", "slack", "--no-slack"], { cwd: repoRoot });
  assert.equal(conflictingSurface.code, 2);
  assert.match(conflictingSurface.out, /--no-slack conflicts with --surface slack/);

  const irrelevant = runCli(["dev", "status", "--rotate"], { cwd: repoRoot });
  assert.equal(irrelevant.code, 2);
  assert.match(irrelevant.out, /status does not support --rotate/);
});

test("dev up forwards a Slack surface to the canonical pool path", (t) => {
  const store = tmp("dev-surface-pool");
  t.after(() => rmDir(store));
  const result = runCli(["dev", "up", "--surface", "slack"], {
    cwd: repoRoot,
    env: { QM_POOL_STORE: store, DEV_INSTANCE_WAIT: "0" },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.out, /no free pool app/);
  assert.doesNotMatch(result.out, /unknown option/);
});

test("dev --ci with an unsupported subcommand is a clear usage error", () => {
  const result = runCli(["dev", "--ci", "frobnicate"], { cwd: repoRoot });
  assert.equal(result.code, 1);
  assert.match(result.out, /'dev --ci' supports up\|down/);
});

test("bare `dev --ci` defaults to CI up (not the pool-leasing dev path)", () => {
  const result = runCli(["dev", "--ci"], { cwd: repoRoot, env: { SLACK_BOT_TOKEN: undefined } });
  assert.equal(result.code, 1);
  assert.match(result.out, /SLACK_BOT_TOKEN/);
});
