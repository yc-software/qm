import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { repoRoot, runCli, tmp, rmDir, writeConfig, fakeFlyEnv, fakeFlyCommands } from "./harness.ts";

const APP_PREFIX = "qm-e2e";
const ALL_SECRETS = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_ENDPOINT_URL_S3",
  "AWS_SECRET_ACCESS_KEY",
  "CAPABILITY_SECRET",
  "CONNECTOR_SECRET_KEY",
  "CORE_SIGNING_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "SKILL_SIGNING_SECRET",
  "PUBLIC_API_URL",
  "FLY_API_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
];

after(() => rmDir(join(repoRoot, "deploy", "stacks", ".generated", APP_PREFIX)));

function flyConfig(label: string): string {
  const dir = tmp(label);
  return writeConfig(dir, {
    orgId: "acme",
    target: "fly",
    appPrefix: APP_PREFIX,
    flyOrg: "e2e-org",
    region: "sjc",
    services: ["core", "web-ui"],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "qm-e2e-data", S3_REGION: "auto" } },
  });
}

function fly(
  args: string[],
  cfg: string,
  fakeOpts: Parameters<typeof fakeFlyEnv>[0] = {},
): { result: ReturnType<typeof runCli>; logPath: string } {
  const identity = "qm-v2:e2e-org:acme:qm-e2e";
  const defaults = {
    apps: ["qm-e2e-core", "qm-e2e-web-ui"],
    appOwners: { "qm-e2e-core": identity, "qm-e2e-web-ui": identity },
  };
  const { env, logPath } = fakeFlyEnv({
    ...defaults,
    ...fakeOpts,
    appOwners: { ...defaults.appOwners, ...fakeOpts.appOwners },
  });
  const result = runCli([...args, "--config", cfg], { cwd: repoRoot, env });
  return { result, logPath };
}

test("plan (fly) reports MISSING secrets when none are staged, and changes nothing", () => {
  const cfg = flyConfig("fly-plan-missing");
  const { result, logPath } = fly(["plan"], cfg, { secrets: [] });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /target: fly, plan/);
  assert.match(result.out, /MISSING secrets/);
  assert.match(result.out, /Plan only\. Re-run without --dry-run to deploy\./);
  const cmds = fakeFlyCommands(logPath);
  assert.ok(cmds.some((c) => c[0] === "secrets" && c[1] === "list" && c.includes("qm-e2e-core")));
  assert.ok(cmds.some((c) => c[0] === "secrets" && c[1] === "list" && c.includes("qm-e2e-web-ui")));
  assert.ok(!cmds.some((c) => c[0] === "deploy"), "plan must not deploy");
});

test("plan (fly) reports secrets: ok when every required secret is staged", () => {
  const cfg = flyConfig("fly-plan-ok");
  const { result } = fly(["plan"], cfg, { secrets: ALL_SECRETS });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /secrets: ok/);
  assert.doesNotMatch(result.out, /MISSING secrets/);
});

test("--target fly overrides a docker config's target for one run", () => {
  const dir = tmp("fly-target-override");
  const cfg = writeConfig(dir, {
    orgId: APP_PREFIX,
    target: "docker",
    appPrefix: APP_PREFIX,
    flyOrg: "e2e-org",
    region: "sjc",
    services: ["core"],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "qm-e2e-data", S3_REGION: "auto" } },
  });
  const { result } = fly(["plan", "--target", "fly"], cfg, { secrets: [] });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /target: fly/);
  assert.doesNotMatch(result.out, /FLY_DEPLOY_API_TOKEN/, "a Fly target does not opt into the separate app publisher");
  assert.match(
    result.out,
    /PUBLIC_API_URL/,
    "all backend calls receive the effective target, not the persisted Docker target",
  );
});

test("an explicit Fly --build-from path never falls back to another checkout", () => {
  const cfg = flyConfig("fly-explicit-build-from");
  const { result } = fly(["plan", "--build-from", "/definitely/not/a/qm/checkout"], cfg, { secrets: [] });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /--build-from requires a QM checkout/);
});

test("Fly rejects conflicting image-source flags instead of silently ignoring one", () => {
  const cfg = flyConfig("fly-conflicting-image-source");
  for (const args of [
    ["plan", "--build-from", repoRoot, "--image-label", "candidate"],
    ["plan", "--build-from", repoRoot, "--image-from", "other"],
    ["plan", "--image-label", "candidate", "--image-from", "other"],
    ["plan", "--build-only", "--image-label", "candidate", "--image-from", "other"],
    ["plan", "--build-only", "--image-label", "candidate", "--image-repo-prefix", "other"],
  ]) {
    const { result } = fly(args, cfg, { secrets: [] });
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /cannot be combined|select different image sources/);
  }
});

test("explicit --build-from overrides a configured imageFrom default", () => {
  const dir = tmp("fly-build-over-config-image");
  const cfg = writeConfig(dir, {
    orgId: "acme",
    target: "fly",
    appPrefix: APP_PREFIX,
    flyOrg: "e2e-org",
    region: "sjc",
    imageFrom: "configured-source",
    services: ["core"],
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "qm-e2e-data", S3_REGION: "auto" } },
  });
  const { result } = fly(["plan", "--build-from", repoRoot], cfg, { secrets: [] });
  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(result.out, /image-from configured-source/);
});

test("--only narrows a fly plan to the named component (and rejects unknown names)", () => {
  const cfg = flyConfig("fly-only");
  const { result, logPath } = fly(["plan", "--only", "core"], cfg, { secrets: [] });
  assert.equal(result.code, 0, result.out);
  const cmds = fakeFlyCommands(logPath);
  assert.ok(
    cmds.some((c) => c.includes("qm-e2e-core")),
    "gated core",
  );
  assert.ok(!cmds.some((c) => c.includes("qm-e2e-web-ui")), "did NOT touch web-ui");

  const bad = fly(["plan", "--only", "nope"], cfg, { secrets: [] });
  assert.equal(bad.result.code, 1);
  assert.match(bad.result.out, /not a service or plugin/);

  const duplicate = fly(["plan", "--only", "core,core"], cfg, { secrets: [] });
  assert.equal(duplicate.result.code, 1);
  assert.match(duplicate.result.out, /--only lists core more than once/);
});

test("status (fly) shells flyctl status per app", () => {
  const cfg = flyConfig("fly-status");
  const { result, logPath } = fly(["status"], cfg);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /qm status — qm-e2e \(target: fly\)/);
  const cmds = fakeFlyCommands(logPath);
  assert.ok(cmds.some((c) => c[0] === "status" && c.includes("qm-e2e-core")));
  assert.ok(cmds.some((c) => c[0] === "status" && c.includes("qm-e2e-web-ui")));
});

test("logs (fly) shells flyctl logs, and notes that --tail is docker-only", () => {
  const cfg = flyConfig("fly-logs");
  const one = fly(["logs", "core", "--tail", "10"], cfg);
  assert.equal(one.result.code, 0, one.result.out);
  assert.match(one.result.out, /--tail is a docker-only line count/);
  assert.ok(fakeFlyCommands(one.logPath).some((c) => c[0] === "logs" && c.includes("qm-e2e-core")));

  const all = fly(["logs"], cfg);
  assert.equal(all.result.code, 0, all.result.out);
  const cmds = fakeFlyCommands(all.logPath);
  assert.ok(cmds.some((c) => c[0] === "logs" && c.includes("qm-e2e-core")));
  assert.ok(cmds.some((c) => c[0] === "logs" && c.includes("qm-e2e-web-ui")));
});

test("logs -f/--follow streams (flyctl's default: no --no-tail)", () => {
  const cfg = flyConfig("fly-logs-follow");
  for (const flag of ["--follow", "-f"]) {
    const { result, logPath } = fly(["logs", "core", flag], cfg);
    assert.equal(result.code, 0, result.out);
    const logsCmd = fakeFlyCommands(logPath).find((c) => c[0] === "logs");
    assert.ok(logsCmd, `${flag}: flyctl logs invoked`);
    assert.ok(!logsCmd!.includes("--no-tail"), `${flag}: streaming (no --no-tail)`);
  }
});

test("down (fly) scales every app to 0", () => {
  const cfg = flyConfig("fly-down");
  const { result, logPath } = fly(["down"], cfg);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /scaling every app to 0/);
  const cmds = fakeFlyCommands(logPath);
  for (const app of ["qm-e2e-core", "qm-e2e-web-ui"]) {
    assert.ok(
      cmds.some((c) => c[0] === "scale" && c[1] === "count" && c[2] === "0" && c.includes(app)),
      `scaled ${app} to 0`,
    );
  }
});

test("down (fly) scales a removed-but-running plugin, but never a sibling/deploy/unrelated app", () => {
  const cfg = flyConfig("fly-down-removed");
  const { result, logPath } = fly(["down"], cfg, {
    apps: [
      "qm-e2e-core",
      "qm-e2e-web-ui",
      "qm-e2e-linear",
      "qm-e2e-2-core",
      "qm-e2e-2-slack",
      "qm-e2e-2-billing",
      "qm-e2e-payments",
      "qm-e2e-d-acme-blog",
      "other-deploy-core",
    ],
    appOwners: {
      "qm-e2e-core": "qm-v2:e2e-org:acme:qm-e2e",
      "qm-e2e-web-ui": "qm-v2:e2e-org:acme:qm-e2e",
      "qm-e2e-linear": "qm-v2:e2e-org:acme:qm-e2e",
      "qm-e2e-2-core": "qm-v2:e2e-org:acme:qm-e2e-2",
      "qm-e2e-2-slack": "qm-v2:e2e-org:acme:qm-e2e-2",
      "qm-e2e-2-billing": "qm-v2:e2e-org:acme:qm-e2e-2",
    },
  });
  assert.equal(result.code, 0, result.out);
  const scaled = fakeFlyCommands(logPath)
    .filter((c) => c[0] === "scale" && c[1] === "count" && c[2] === "0")
    .map((c) => c[c.indexOf("-a") + 1]);
  for (const app of ["qm-e2e-core", "qm-e2e-web-ui", "qm-e2e-linear"]) {
    assert.ok(scaled.includes(app), `scaled ${app} to 0 (incl. the removed plugin still on Fly)`);
  }
  for (const app of ["qm-e2e-2-core", "qm-e2e-2-slack", "qm-e2e-2-billing"]) {
    assert.ok(!scaled.includes(app), `nested sibling app ${app} must NOT be touched`);
  }
  assert.ok(!scaled.includes("qm-e2e-payments"), "a same-prefix app without our deployment marker must NOT be touched");
  assert.ok(!scaled.includes("qm-e2e-d-acme-blog"), "published deploy apps have their own lifecycle — not torn down");
  assert.ok(!scaled.includes("other-deploy-core"), "another deployment's apps (different prefix) are never touched");
});

test("down (fly) continues known apps but fails honestly when a same-prefix candidate cannot be inspected", () => {
  const cfg = flyConfig("fly-down-unverified");
  const { result, logPath } = fly(["down"], cfg, {
    apps: ["qm-e2e-core", "qm-e2e-web-ui", "qm-e2e-linear", "qm-e2e-payments"],
    appOwners: {
      "qm-e2e-core": "qm-v2:e2e-org:acme:qm-e2e",
      "qm-e2e-web-ui": "qm-v2:e2e-org:acme:qm-e2e",
      "qm-e2e-linear": "qm-v2:e2e-org:acme:qm-e2e",
    },
    failStatusApps: ["qm-e2e-payments"],
  });
  assert.equal(result.code, 1, result.out);
  assert.match(
    result.out,
    /down incomplete — could not verify deployment ownership for 1 app; left untouched:[\s\S]*qm-e2e-payments/,
  );
  assert.doesNotMatch(result.out, /down — all apps scaled to 0/);
  const scaled = fakeFlyCommands(logPath)
    .filter((command) => command[0] === "scale")
    .map((command) => command[command.indexOf("-a") + 1]);
  assert.deepEqual(scaled, ["qm-e2e-core", "qm-e2e-web-ui", "qm-e2e-linear"]);
});

test("up --build-only and --image-repo-prefix require --image-label", () => {
  const cfg = flyConfig("fly-require-label");
  const buildOnly = fly(["up", "--only", "core", "--build-only"], cfg);
  assert.equal(buildOnly.result.code, 1);
  assert.match(buildOnly.result.out, /--build-only requires --image-label/);

  const repoPrefix = fly(["up", "--only", "core", "--image-repo-prefix", "qm"], cfg);
  assert.equal(repoPrefix.result.code, 1);
  assert.match(repoPrefix.result.out, /--image-repo-prefix requires --image-label/);
});

test("down (fly) attempts every app, aggregates failures, and exits nonzero", () => {
  const cfg = flyConfig("fly-down-fail");
  const { result, logPath } = fly(["down"], cfg, { fail: "scale" });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /down incomplete — failed to scale 2 apps to 0/);
  assert.match(result.out, /qm-e2e-core.*qm-e2e-web-ui/s);
  assert.doesNotMatch(result.out, /down — all apps scaled to 0/);
  const attempted = fakeFlyCommands(logPath)
    .filter((command) => command[0] === "scale")
    .map((command) => command[command.indexOf("-a") + 1]);
  assert.deepEqual(attempted, ["qm-e2e-core", "qm-e2e-web-ui"]);
});

test("down (fly) exits nonzero when flyctl is missing instead of reporting a no-op as success", () => {
  const cfg = flyConfig("fly-down-no-flyctl");
  const result = runCli(["down", "--config", cfg], {
    cwd: repoRoot,
    env: { FLY_BIN: "flyctl-not-installed-xyz" },
  });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /flyctl-not-installed-xyz scale count 0 -a qm-e2e-core/);
  assert.match(result.out, /down incomplete — flyctl is not installed, so no apps were scaled to 0/);
  assert.doesNotMatch(result.out, /down — all apps scaled to 0/);
});

test("down (fly) leaves configured apps untouched when organization ownership discovery fails", () => {
  const cfg = flyConfig("fly-down-discovery-fail");
  const { result, logPath } = fly(["down"], cfg, { fail: "apps" });
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /could not verify deployment ownership[\s\S]*apps list[\s\S]*fake fly failure/);
  const scaled = fakeFlyCommands(logPath)
    .filter((command) => command[0] === "scale")
    .map((command) => command[command.indexOf("-a") + 1]);
  assert.deepEqual(scaled, []);
  assert.doesNotMatch(result.out, /down — all apps scaled to 0/);
});

test("fly status with no flyctl installed prints the exact commands to run", () => {
  const cfg = flyConfig("fly-noflyctl");
  const result = runCli(["status", "--config", cfg], {
    cwd: repoRoot,
    env: { FLY_BIN: "flyctl-not-installed-xyz" },
  });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /flyctl not found — run:/);
  assert.match(result.out, /flyctl-not-installed-xyz status -a qm-e2e-core/);
});
