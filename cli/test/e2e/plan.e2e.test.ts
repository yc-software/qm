import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  runCli,
  tmp,
  tmpGitRepo,
  rmDir,
  writeConfig,
  standInCheckout,
  standInPlugin,
  repoRoot,
  dockerAvailable,
  deploymentContainers,
  deploymentNetworks,
} from "./harness.ts";

test("plan reports the docker plan (network, images, env, layer, plugins) and starts nothing", () => {
  const dir = tmp("plan-docker");
  const org = `qm-e2e-plan-${process.pid}`;
  try {
    writeConfig(dir, {
      orgId: org,
      target: "docker",
      services: ["core", "web-ui"],
      plugins: [{ name: "ext", image: "ghcr.io/example/ext:1.2" }],
    });
    standInPlugin(dir, "widget");

    const r = runCli(["plan"], { cwd: dir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /DRY RUN/);
    assert.match(r.out, new RegExp(`network: qm-${org}`));
    assert.match(r.out, /core: image registry\.invalid\/qm\/qm-core@sha256:a{64}/);
    assert.match(r.out, /env: .*\bORG_ID\b/);
    assert.match(r.out, /layer:/);
    assert.match(r.out, /plugin widget: build plugins\/widget\/Dockerfile/);
    assert.match(r.out, /plugin ext: pull ghcr\.io\/example\/ext:1\.2/);
    assert.match(r.out, /Plan only/);

    if (dockerAvailable()) {
      assert.deepEqual(deploymentContainers(org), []);
      assert.deepEqual(deploymentNetworks(org), []);
    }
  } finally {
    rmDir(dir);
  }
});

test("plan is exactly `up --dry-run`", () => {
  const dir = tmp("plan-alias");
  try {
    writeConfig(dir, { orgId: "acme", target: "docker", services: ["core"] });
    const viaPlan = runCli(["plan"], { cwd: dir });
    const viaUp = runCli(["up", "--dry-run"], { cwd: dir });
    assert.equal(viaPlan.code, 0, viaPlan.out);
    assert.equal(viaUp.code, 0, viaUp.out);
    for (const out of [viaPlan.out, viaUp.out]) {
      assert.match(out, /DRY RUN/);
      assert.match(out, /Plan only/);
    }
  } finally {
    rmDir(dir);
  }
});

test("plan reports missing required operator secrets without starting anything", () => {
  const dir = tmp("plan-secrets");
  try {
    writeConfig(dir, { orgId: "acme", target: "docker", services: ["core", "slack"] });
    const envFile = join(dir, "partial.env");
    writeFileSync(envFile, "CORE_SIGNING_SECRET=a\nSKILL_SIGNING_SECRET=b\n");
    const r = runCli(["plan", "--env-file", envFile], {
      cwd: dir,
      env: { SLACK_BOT_TOKEN: undefined, SLACK_APP_TOKEN: undefined },
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /MISSING required secrets/);
    assert.doesNotMatch(r.out, /SLACK_APP_TOKEN|SLACK_BOT_TOKEN/);
  } finally {
    rmDir(dir);
  }
});

test("plan --build-from <path> shows local builds instead of registry pulls", () => {
  const dir = tmp("plan-buildfrom");
  const checkout = standInCheckout(["core"]);
  try {
    writeConfig(dir, { orgId: "acme", target: "docker", services: ["core"] });
    const r = runCli(["plan", "--build-from", checkout], { cwd: dir });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /core: image build deploy\/core\/Dockerfile/);
    assert.doesNotMatch(r.out, /pull/);
  } finally {
    rmDir(dir);
    rmDir(checkout);
  }
});

test("bare plan --build-from builds from the enclosing qm checkout", () => {
  const stack = tmp("plan-buildfrom-bare");
  try {
    const cfg = writeConfig(stack, { orgId: "acme", target: "docker", services: ["core"] });
    const r = runCli(["plan", "--build-from", "--config", cfg], { cwd: repoRoot });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /core: image build deploy\/core\/Dockerfile/);
  } finally {
    rmDir(stack);
  }
});

test("bare plan --build-from rejects an unrelated enclosing Git repository", () => {
  const dir = tmpGitRepo("plan-buildfrom-wrong-repo");
  try {
    writeConfig(dir, { orgId: "acme", target: "docker", services: ["core"] });
    const r = runCli(["plan", "--build-from"], { cwd: dir });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not a QM checkout \(missing deploy\/core\/Dockerfile\)/);
  } finally {
    rmDir(dir);
  }
});

test("plan honors a host port base from the config", () => {
  const dir = tmp("plan-port");
  try {
    writeConfig(dir, { orgId: "acme", target: "docker", services: ["core"], basePort: 31080 });
    const r = runCli(["plan"], { cwd: dir, env: { QM_BASE_PORT: undefined } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /core: image .*\(host :31080\)/);
  } finally {
    rmDir(dir);
  }
});

test("plan honors QM_BASE_PORT over the config", () => {
  const dir = tmp("plan-portenv");
  try {
    writeConfig(dir, { orgId: "acme", target: "docker", services: ["core"], basePort: 31080 });
    const r = runCli(["plan"], { cwd: dir, env: { QM_BASE_PORT: "32099" } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\(host :32099\)/);
  } finally {
    rmDir(dir);
  }
});

test("plan --config points at a config kept elsewhere", () => {
  const home = tmp("plan-cfg-home");
  const stack = tmp("plan-cfg-stack");
  try {
    const cfgPath = writeConfig(stack, { orgId: "acme", target: "docker", services: ["core"] });
    const r = runCli(["plan", "--config", cfgPath], { cwd: home });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /DRY RUN/);
  } finally {
    rmDir(home);
    rmDir(stack);
  }
});

test("plan --env-file: a missing one errors, an existing one is accepted", () => {
  const dir = tmp("plan-envfile");
  try {
    writeConfig(dir, { orgId: "acme", target: "docker", services: ["core"] });
    const missing = runCli(["plan", "--env-file", join(dir, "nope.env")], { cwd: dir });
    assert.equal(missing.code, 1, missing.out);
    assert.match(missing.out, /--env-file not found/);

    const envPath = join(dir, "operator.env");
    writeFileSync(envPath, "CORE_SIGNING_SECRET=test\nSKILL_SIGNING_SECRET=test\n");
    const ok = runCli(["plan", "--env-file", envPath], { cwd: dir });
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /DRY RUN/);
  } finally {
    rmDir(dir);
  }
});

test("plan --sandbox-dir reports a sandbox layer kept outside the deployment dir", () => {
  const layerSrc = tmp("plan-layer-src");
  const dep = tmp("plan-layer-dep");
  try {
    assert.equal(runCli(["init", layerSrc, "--org", "acme"]).code, 0);
    writeConfig(dep, { orgId: "acme", target: "docker", services: ["core"] });
    const r = runCli(["plan", "--sandbox-dir", join(layerSrc, "sandbox")], { cwd: dep });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /layer: .*sandbox.*\(skills, tools\)/);
  } finally {
    rmDir(layerSrc);
    rmDir(dep);
  }
});
