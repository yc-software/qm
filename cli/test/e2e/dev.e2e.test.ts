import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, rmDir, runCli, tmp, tmpGitRepo, writeConfig } from "./harness.ts";

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

  const irrelevant = runCli(["dev", "status", "--rotate"], { cwd: repoRoot });
  assert.equal(irrelevant.code, 2);
  assert.match(irrelevant.out, /status does not support --rotate/);
});

test("dev up accepts an org override before entering the canonical pool path", (t) => {
  const store = tmp("dev-org-pool");
  t.after(() => rmDir(store));
  const result = runCli(["dev", "up", "--org", "beta"], {
    cwd: repoRoot,
    env: { QM_POOL_STORE: store, DEV_INSTANCE_WAIT: "0" },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.out, /no free pool app/);
  assert.doesNotMatch(result.out, /does not support --org|unknown option/);

  const invalid = runCli(["dev", "up", "--org", "beta\nINJECTED=1"], {
    cwd: repoRoot,
    env: { QM_POOL_STORE: store, DEV_INSTANCE_WAIT: "0" },
  });
  assert.equal(invalid.code, 2);
  assert.match(invalid.out, /--org must be a lowercase DNS label/);
  assert.doesNotMatch(invalid.out, /no free pool app/);

  const empty = runCli(["dev", "up", "--org="], {
    cwd: repoRoot,
    env: { QM_POOL_STORE: store, DEV_INSTANCE_WAIT: "0" },
  });
  assert.equal(empty.code, 2);
  assert.match(empty.out, /--org must be a lowercase DNS label/);
});

test("delegated dev resolves org overrides, config, and fallback", (t) => {
  const withConfig = tmpGitRepo("dev-org-config");
  const withInvalidConfig = tmpGitRepo("dev-org-invalid-config");
  const withoutConfig = tmpGitRepo("dev-org-fallback");
  t.after(() => {
    rmDir(withConfig);
    rmDir(withInvalidConfig);
    rmDir(withoutConfig);
  });
  for (const root of [withConfig, withInvalidConfig, withoutConfig]) {
    mkdirSync(join(root, "scripts/dev"), { recursive: true });
    writeFileSync(join(root, "scripts/dev/cli.ts"), "console.log(process.env.DEV_INSTANCE_ORG_ID);\n");
  }
  writeConfig(withConfig, { orgId: "configured", target: "docker" });
  writeFileSync(
    join(withInvalidConfig, "qm.config.jsonc"),
    '{ // deploy config may be broken\n  "orgId": "configured",\n  "target": "k8s"\n}\n',
  );

  assert.equal(runCli(["dev", "status"], { cwd: withConfig, withRepoEnv: false }).stdout.trim(), "configured");
  assert.equal(runCli(["dev", "status"], { cwd: withInvalidConfig, withRepoEnv: false }).stdout.trim(), "configured");
  assert.equal(
    runCli(["dev", "up", "--org", "override"], { cwd: withConfig, withRepoEnv: false }).stdout.trim(),
    "override",
  );
  assert.equal(runCli(["dev", "status"], { cwd: withoutConfig, withRepoEnv: false }).stdout.trim(), "acme");
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
