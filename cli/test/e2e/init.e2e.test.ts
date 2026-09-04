import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILENAME, loadConfigAt } from "../../src/config.ts";
import { runCli, tmp, rmDir } from "./harness.ts";

test("init --org scaffolds config + generated .env + a runnable sandbox/, which `check` accepts", () => {
  const root = tmp("init");
  const dir = join(root, "acme-deploy");
  try {
    const r = runCli(["init", dir, "--org", "acme"]);
    assert.equal(r.code, 0, r.out);

    const cfgPath = join(dir, CONFIG_FILENAME);
    assert.ok(existsSync(cfgPath), "config written");
    const cfg = loadConfigAt(cfgPath).config;
    assert.equal(cfg.orgId, "acme");
    assert.equal(cfg.target, "docker");
    assert.deepEqual(cfg.sandbox, { app: "acme-sandboxes" });

    assert.ok(existsSync(join(dir, ".env.example")), ".env.example written");
    assert.ok(existsSync(join(dir, ".env")), ".env written with generated local keys");
    assert.ok(existsSync(join(dir, "slack-app-manifest.yml")), "Slack bot manifest written");
    assert.equal(existsSync(join(dir, "slack-sso-manifest.yml")), false);
    assert.ok(existsSync(join(dir, "sandbox", "skills", "greet", "SKILL.md")));
    assert.ok(existsSync(join(dir, "sandbox", "tools", "example-tool", "tool.json")));
    const toolBin = join(dir, "sandbox", "tools", "example-tool", "example-tool");
    assert.ok(existsSync(toolBin), "example tool executable written");
    assert.ok(statSync(toolBin).mode & 0o111, "example tool is executable");

    const checked = runCli(["check"], { cwd: dir });
    assert.equal(checked.code, 0, checked.out);
    assert.match(checked.out, /check passed/);
  } finally {
    rmDir(root);
  }
});

test("init --target fly writes a fly-target config", () => {
  const dir = tmp("init-fly");
  try {
    const r = runCli(["init", dir, "--org", "qm", "--target", "fly"]);
    assert.equal(r.code, 0, r.out);
    const cfg = loadConfigAt(join(dir, CONFIG_FILENAME)).config;
    assert.equal(cfg.target, "fly");
    assert.equal(cfg.orgId, "qm");
  } finally {
    rmDir(dir);
  }
});

test("init --target aws vendors infrastructure and passes check", () => {
  const dir = tmp("init-aws");
  try {
    const initialized = runCli(["init", dir, "--org", "acme", "--target", "aws"]);
    assert.equal(initialized.code, 0, initialized.out);
    const cfg = loadConfigAt(join(dir, CONFIG_FILENAME)).config;
    assert.equal(cfg.target, "aws");
    assert.equal(cfg.aws?.imageLabel, "latest");
    for (const file of ["main.tf", "outputs.tf", "variables.tf", "versions.tf", "terraform.tfvars"]) {
      assert.ok(existsSync(join(dir, "infra", file)), `infra/${file} written`);
    }
    assert.ok(existsSync(join(dir, "slack-app-manifest.yml")), "Slack bot manifest written");
    assert.equal(existsSync(join(dir, "slack-sso-manifest.yml")), false);
    const checked = runCli(["check"], { cwd: dir });
    assert.equal(checked.code, 0, checked.out);
  } finally {
    rmDir(dir);
  }
});

test("init with no --org defaults the org id", () => {
  const dir = tmp("init-default");
  try {
    const r = runCli(["init", dir]);
    assert.equal(r.code, 0, r.out);
    const cfg = loadConfigAt(join(dir, CONFIG_FILENAME)).config;
    assert.equal(cfg.orgId, "default-org");
  } finally {
    rmDir(dir);
  }
});

test("init refuses to clobber an existing deployment", () => {
  const dir = tmp("init-clobber");
  try {
    assert.equal(runCli(["init", dir, "--org", "a"]).code, 0);
    const again = runCli(["init", dir, "--org", "b"]);
    assert.equal(again.code, 1);
    assert.match(again.out, /already exists/);
    const cfg = loadConfigAt(join(dir, CONFIG_FILENAME)).config;
    assert.equal(cfg.orgId, "a");
  } finally {
    rmDir(dir);
  }
});

test("an invalid --target is rejected before anything is written", () => {
  const dir = tmp("init-badtarget");
  try {
    const r = runCli(["init", dir, "--target", "kubernetes"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /--target must be docker, fly, or aws/);
    assert.ok(!existsSync(join(dir, CONFIG_FILENAME)), "no config on a rejected target");
  } finally {
    rmDir(dir);
  }
});
