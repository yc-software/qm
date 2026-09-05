import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";
import { main } from "../src/cli.ts";
import { renderTaskDefinition } from "../src/backends/aws.ts";
import { computedSecrets } from "../src/secrets.ts";

const PINNED_SANDBOX_IMAGE = `registry.fly.io/acme-sandboxes@sha256:${"b".repeat(64)}`;

async function run(argv: string[], cwd?: string): Promise<{ out: string; exitCode: number | null }> {
  const lines: string[] = [];
  const log = console.log,
    error = console.error,
    exit = process.exit;
  const previousExitCode = process.exitCode;
  const prevCwd = process.cwd();
  let exitCode: number | null = null;
  console.log = (...a: unknown[]): void => void lines.push(a.join(" "));
  console.error = (...a: unknown[]): void => void lines.push(a.join(" "));
  (process as { exit: (c?: number) => never }).exit = ((c?: number) => {
    exitCode = c ?? 0;
    throw new Error(`__exit_${exitCode}`);
  }) as (c?: number) => never;
  if (cwd) process.chdir(cwd);
  try {
    await main(argv);
  } catch (e) {
    if (!(e as Error).message?.startsWith("__exit_")) throw e;
  } finally {
    if (exitCode === null && typeof process.exitCode === "number") exitCode = process.exitCode;
    process.exitCode = previousExitCode;
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.chdir(prevCwd);
  }
  return { out: lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), exitCode };
}

test("help lists every deploy + develop command and the deploy-wide options", async () => {
  for (const argv of [["help"], ["--help"], ["-h"], [] as string[]]) {
    const { out } = await run(argv);
    for (const cmd of [
      "init",
      "up",
      "plan",
      "check",
      "config get",
      "admin-login",
      "status",
      "logs",
      "down",
      "sandbox build",
      "infra build-image",
      "infra delete-task-definitions",
    ]) {
      assert.match(out, new RegExp(`\\b${cmd.replace(" ", "\\s")}`), `help should list ${cmd}`);
    }
    for (const cmd of ["up", "down", "status", "restart", "canary", "logs", "doctor"])
      assert.match(out, new RegExp(`dev\\s+${cmd}`));
    assert.match(out, /dev\s+--ci/);
    for (const opt of ["--config", "--env-file", "--sandbox-dir", "--build-from", "--dry-run", "--purge", "--tail"]) {
      assert.match(out, new RegExp(opt.replace(/-/g, "\\-")), `help should mention ${opt}`);
    }
  }
});

test("check --json reports failures under a stable contract clause id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 2,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
    }),
  );
  try {
    const { out, exitCode } = await run(["check", "--json"], dir);
    assert.equal(exitCode, 1);
    const result = JSON.parse(out) as { valid: boolean; clauses: Record<string, unknown> };
    assert.equal(result.valid, false);
    assert.deepEqual(Object.keys(result.clauses), ["config.v1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check --json treats malformed contract JSON as a contract failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(join(dir, CONFIG_FILENAME), "{ not json");
  try {
    const { out, exitCode } = await run(["check", "--json"], dir);
    assert.equal(exitCode, 1);
    const result = JSON.parse(out) as { valid: boolean };
    assert.equal(result.valid, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check --json reserves exit 2 for an unsupported live invocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    }),
  );
  try {
    const { out, exitCode } = await run(["check", "--json", "--live"], dir);
    assert.equal(exitCode, 2, out);
    const result = JSON.parse(out) as { clauses: Record<string, { status: string }> };
    assert.equal(result.clauses["cli.invocation"]?.status, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check flag typos are invocation errors and never print a success first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    }),
  );
  try {
    const json = await run(["check", "--json", "--jsno"], dir);
    assert.equal(json.exitCode, 2, json.out);
    const parsed = JSON.parse(json.out) as { clauses: Record<string, { status: string }> };
    assert.equal(parsed.clauses["cli.invocation"]?.status, "error");
    const buildFrom = await run(["check", "--build-from", "/tmp/checkout"], dir);
    assert.equal(buildFrom.exitCode, 2, buildFrom.out);
    assert.match(buildFrom.out, /unknown option: --build-from/);
    const live = await run(["check", "--live"], dir);
    assert.equal(live.exitCode, 2, live.out);
    assert.doesNotMatch(live.out, /check passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-JSON check --live fails when the target has no live drift implementation (exit 2, like --json)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    }),
  );
  try {
    const { out, exitCode } = await run(["check", "--live"], dir);
    assert.equal(exitCode, 2, out);
    assert.match(out, /check --live is not implemented for target docker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check --live on aws runs live drift checks in plain and JSON modes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  const aws = join(dir, "aws-fake");
  writeFileSync(
    aws,
    `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.includes("sts get-caller-identity")) console.log("123456789012");
else if (args.includes("get-secret-value")) console.log(JSON.stringify({ ARN: "arn", SecretString: "secret-value".repeat(3) }));
else if (args.includes("describe-services")) console.log(JSON.stringify({ services: [{ serviceName: "s" }] }));
else console.log("{}");
`,
  );
  chmodSync(aws, 0o755);
  const config = {
    contract: 1,
    orgId: "acme",
    publicUrl: "http://localhost:8080",
    target: "aws",
    services: ["core"],
    env: { core: { AWS_DEPLOY_IMAGE: "acme-microvm-app", AWS_DEPLOY_IMAGE_VERSION: "1" } },
    imageOverrides: { core: `ghcr.io/acme/core@sha256:${"a".repeat(64)}` },
    sandbox: { backend: "sprites", app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    aws: {
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "c",
      deployRoleArn: "arn:aws:iam::123456789012:role/d",
      secretsPrefix: "p/",
      imageLabel: "release",
      networking: { cloudMapNamespace: "n" },
      services: { core: { ecrRepository: "repo", ecsService: "s", cpu: 256, memory: 512, architecture: "arm64" } },
    },
  };
  writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify(config));
  const previousAwsBin = process.env.AWS_BIN;
  process.env.AWS_BIN = aws;
  try {
    const plain = await run(["check", "--live"], dir);
    assert.equal(plain.exitCode, 1, plain.out);
    assert.match(plain.out, /live drift detected/);
    const json = await run(["check", "--json", "--live"], dir);
    assert.equal(json.exitCode, 1, json.out);
    const result = JSON.parse(json.out) as { clauses: Record<string, { status: string }> };
    assert.equal(result.clauses["aws.live-drift"]?.status, "fail");
  } finally {
    if (previousAwsBin === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = previousAwsBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful check --json --live reports the live-drift clause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  const aws = join(dir, "aws-fake");
  const digest = `sha256:${"a".repeat(64)}`;
  const raw = {
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "aws",
    services: ["core"],
    env: { core: { AWS_DEPLOY_IMAGE: "acme-microvm-app", AWS_DEPLOY_IMAGE_VERSION: "1" } },
    imageOverrides: { core: `ghcr.io/acme/core@${digest}` },
    sandbox: { backend: "sprites", app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    aws: {
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "c",
      deployRoleArn: "arn:aws:iam::123456789012:role/d",
      secretsPrefix: "p/",
      imageLabel: "release",
      networking: { cloudMapNamespace: "n" },
      services: { core: { ecrRepository: "repo", ecsService: "s", cpu: 256, memory: 512, architecture: "arm64" } },
    },
  };
  const configPath = join(dir, CONFIG_FILENAME);
  writeFileSync(configPath, JSON.stringify(raw));
  const config = loadConfigAt(configPath).config;
  const arns = Object.fromEntries(computedSecrets(config).map((secret) => [secret.name, "arn"]));
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/repo@${digest}`;
  const task = renderTaskDefinition(config, "core", image, arns);
  const layerBody = JSON.stringify({ contract: 1, tools: [], skills: [] });
  const layerHash = createHash("sha256").update(layerBody).digest("hex");
  const targetGroupName = `c-core-${createHash("sha1").update("c:core").digest("hex").slice(0, 6)}`;
  const manifest = {
    id: "manifest",
    createdAt: "2026-01-01T00:00:00.000Z",
    imageLabel: "release",
    tasks: { core: "task" },
    layer: { key: `deployment/layers/${layerHash}.json`, sha256: layerHash },
  };
  writeFileSync(
    aws,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const args = argv.join(" ");
if (args.includes("sts get-caller-identity")) console.log("123456789012");
else if (args.includes("lambda-microvms get-microvm-image")) console.log(JSON.stringify({ imageArn: "arn:aws:lambda:us-west-2:123456789012:microvm-image:acme-microvm-app" }));
else if (args.includes("lambda-microvms list-microvm-image-versions")) console.log(JSON.stringify({ items: [{ imageVersion: "1", state: "SUCCESSFUL", status: "ACTIVE" }] }));
else if (args.includes("get-secret-value") && args.includes("--query SecretString")) console.log("signing-secret".repeat(3));
else if (args.includes("get-secret-value")) console.log(JSON.stringify({ ARN: "arn", SecretString: "secret-value".repeat(3) }));
else if (args.includes("describe-services")) console.log(JSON.stringify({ services: [{ serviceName: "s", status: "ACTIVE", desiredCount: 1, runningCount: 1, taskDefinition: "task", networkConfiguration: { awsvpcConfiguration: { subnets: ["subnet"], securityGroups: ["sg"], assignPublicIp: "DISABLED" } }, deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: "task" }], loadBalancers: [{ targetGroupArn: "tg" }] }] }));
else if (args.includes("describe-task-definition")) console.log(${JSON.stringify(JSON.stringify({ taskDefinition: task }))});
else if (args.includes("run-task")) console.log(JSON.stringify({ tasks: [{ taskArn: "canary" }] }));
else if (args.includes("describe-tasks")) console.log(JSON.stringify({ tasks: [{ containers: [{ name: "core", exitCode: 0 }] }] }));
else if (args.includes("dynamodb get-item") && args.includes("deployment/current")) console.log(JSON.stringify({ Item: { manifestId: { S: "manifest" } } }));
else if (args.includes("dynamodb get-item") && args.includes("deployment/manifest/manifest")) console.log(JSON.stringify({ Item: { manifest: { S: ${JSON.stringify(JSON.stringify(manifest))} } } }));
else if (args.includes("s3api get-object")) fs.writeFileSync(argv[argv.indexOf("--key") + 2], ${JSON.stringify(layerBody)});
else if (args.includes("elbv2 describe-load-balancers")) console.log(JSON.stringify({ LoadBalancers: [{ LoadBalancerArn: "lb", DNSName: "acme.example.com", State: { Code: "active" } }] }));
else if (args.includes("elbv2 describe-listeners")) console.log(JSON.stringify({ Listeners: [{ ListenerArn: "listener", Protocol: "HTTPS", Port: 443, Certificates: [{ CertificateArn: "certificate" }], DefaultActions: [{ Type: "fixed-response", FixedResponseConfig: { StatusCode: "404" } }] }] }));
else if (args.includes("elbv2 describe-target-groups")) console.log(JSON.stringify({ TargetGroups: [{ TargetGroupArn: "tg", TargetGroupName: ${JSON.stringify(targetGroupName)} }] }));
else if (args.includes("elbv2 describe-rules")) console.log(JSON.stringify({ Rules: [{ IsDefault: false, Actions: [{ Type: "forward", TargetGroupArn: "tg" }], Conditions: [{ Field: "path-pattern", PathPatternConfig: { Values: ["/v1/*"] } }] }] }));
else if (args.includes("elbv2 describe-target-health")) console.log(JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: "healthy" } }] }));
else console.log("{}");
`,
  );
  chmodSync(aws, 0o755);
  const previousAwsBin = process.env.AWS_BIN;
  const previousSha = process.env.GITHUB_SHA;
  const previousFetch = globalThis.fetch;
  process.env.AWS_BIN = aws;
  delete process.env.GITHUB_SHA;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        bundle: JSON.parse(layerBody),
        contentHash: layerHash,
        status: "applied",
        runtimeContentHash: layerHash,
      }),
      { status: 200 },
    );
  try {
    const checked = await run(["check", "--json", "--live"], dir);
    assert.equal(checked.exitCode, null, checked.out);
    const result = JSON.parse(checked.out) as { valid: boolean; clauses: Record<string, { status: string }> };
    assert.equal(result.valid, true);
    assert.equal(result.clauses["aws.live-drift"]?.status, "pass");
  } finally {
    if (previousAwsBin === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = previousAwsBin;
    if (previousSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = previousSha;
    globalThis.fetch = previousFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version prints a semver", async () => {
  for (const argv of [["version"], ["--version"], ["-v"]]) {
    const { out } = await run(argv);
    assert.match(out, /\d+\.\d+\.\d+/);
  }
});

test("an unknown command errors (exit 1) and shows help", async () => {
  const { out, exitCode } = await run(["frobnicate"]);
  assert.equal(exitCode, 1);
  assert.match(out, /unknown command: frobnicate/);
});

test("--tail must be a non-negative integer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    }),
  );
  try {
    const { out, exitCode } = await run(["logs", "--tail", "abc"], dir);
    assert.equal(exitCode, 2);
    assert.match(out, /--tail must be a non-negative integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--env-file that does not exist is an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    }),
  );
  const xdg = mkdtempSync(join(tmpdir(), "qm-xdg-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const { out, exitCode } = await run(["plan", "--env-file", join(dir, "nope.env")], dir);
    assert.equal(exitCode, 1);
    assert.match(out, /--env-file not found/);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("docker --only is rejected explicitly instead of silently restarting the full stack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
    }),
  );
  try {
    const result = await run(["plan", "--only", "core"], dir);
    assert.equal(result.exitCode, 2, result.out);
    assert.match(result.out, /--only is not supported for target docker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish directs MicroVM AWS deployments (no sandbox.app) to the image-build path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  const configPath = join(dir, CONFIG_FILENAME);
  const raw = JSON.stringify({
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "aws",
    services: ["core"],
    env: { core: { AWS_DEPLOY_IMAGE: "acme-microvm-app" } },
    aws: {
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "c",
      deployRoleArn: "arn:aws:iam::123456789012:role/d",
      secretsPrefix: "p/",
      imageLabel: "release",
      networking: { cloudMapNamespace: "n" },
      services: { core: { ecrRepository: "repo", ecsService: "s", cpu: 256, memory: 512 } },
    },
  });
  writeFileSync(configPath, raw);
  mkdirSync(join(dir, "sandbox"));
  writeFileSync(join(dir, "sandbox", "Dockerfile"), "FROM scratch\n");
  try {
    const result = await run(["sandbox", "publish", "--dry-run"], dir);
    assert.equal(result.exitCode, 1, result.out);
    assert.match(result.out, /Lambda MicroVM sandboxes/);
    assert.match(result.out, /infra build-image/);
    assert.equal(readFileSync(configPath, "utf8"), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish on an AWS deployment with sandbox.app dry-runs the operator layer image", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  const configPath = join(dir, CONFIG_FILENAME);
  const raw = JSON.stringify({
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "aws",
    services: ["core"],
    env: { core: { AWS_DEPLOY_IMAGE: "acme-microvm-app" } },
    sandbox: { backend: "sprites", app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    aws: {
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "c",
      deployRoleArn: "arn:aws:iam::123456789012:role/d",
      secretsPrefix: "p/",
      imageLabel: "release",
      networking: { cloudMapNamespace: "n" },
      services: { core: { ecrRepository: "repo", ecsService: "s", cpu: 256, memory: 512 } },
    },
  });
  writeFileSync(configPath, raw);
  mkdirSync(join(dir, "sandbox"));
  writeFileSync(join(dir, "sandbox", "Dockerfile"), "FROM scratch\n");
  try {
    const result = await run(["sandbox", "publish", "--dry-run"], dir);
    assert.equal(result.exitCode, null, result.out);
    assert.match(result.out, /sandbox publish → registry\.fly\.io\/acme-sandboxes:latest/);
    assert.match(result.out, /DRY RUN — nothing built, pushed, or recorded/);
    assert.equal(readFileSync(configPath, "utf8"), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destructive commands reject unknown flags before resolving a deployment", async () => {
  for (const argv of [
    ["up", "--dryrun"],
    ["sandbox", "publish", "--dryrun"],
    ["down", "--confg", "/tmp/other"],
    ["rollback", "--too", "v1"],
    ["secrets", "push", "--form", "operator.env"],
    ["infra", "render", "--confg", "/tmp/other"],
  ]) {
    const result = await run(argv);
    assert.equal(result.exitCode, 2, `${argv.join(" ")}: ${result.out}`);
    assert.match(result.out, /unknown option/);
    assert.doesNotMatch(result.out, /no qm\.config/);
  }
});

test("infra delete-task-definitions requires explicit destructive confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "https://agent.acme.example",
      target: "aws",
      services: ["core"],
      plugins: [],
      skills: [],
      env: { core: { HARNESS: "mock", AWS_DEPLOY_IMAGE: "acme-sandbox" } },
      imageOverrides: {},
      aws: {
        accountId: "123456789012",
        region: "us-west-2",
        cluster: "acme-qm",
        deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
        secretsPrefix: "acme/qm/",
        imageLabel: "release",
        networking: { cloudMapNamespace: "acme.internal" },
        services: { core: { ecrRepository: "acme-core", ecsService: "acme-core", cpu: 2048, memory: 4096 } },
      },
    }),
  );
  try {
    const result = await run(["infra", "delete-task-definitions"], dir);
    assert.equal(result.exitCode, 2, result.out);
    assert.match(result.out, /infra delete-task-definitions requires --yes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("destructive commands reject extra positionals and boolean flags never consume them", async () => {
  for (const argv of [
    ["up", "unexpected"],
    ["up", "--dry-run", "unexpected"],
    ["sandbox", "publish", "unexpected"],
    ["down", "--purge", "unexpected"],
    ["rollback", "unexpected"],
    ["secrets", "push", "unexpected"],
    ["infra", "render", "unexpected"],
  ]) {
    const result = await run(argv);
    assert.equal(result.exitCode, 2, `${argv.join(" ")}: ${result.out}`);
    assert.match(result.out, /unexpected argument/);
    assert.doesNotMatch(result.out, /no qm\.config/);
  }
  const valuedBoolean = await run(["sandbox", "publish", "--dry-run=false"]);
  assert.equal(valuedBoolean.exitCode, 2, valuedBoolean.out);
  assert.match(valuedBoolean.out, /--dry-run does not take a value/);
});

test("unknown dev subcommands validate flags and extra arguments before reporting usage", async () => {
  const unknownFlag = await run(["dev", "frobnicate", "--dryrun"]);
  assert.equal(unknownFlag.exitCode, 2, unknownFlag.out);
  assert.match(unknownFlag.out, /unknown option: --dryrun/);

  const extra = await run(["dev", "frobnicate", "unexpected"]);
  assert.equal(extra.exitCode, 2, extra.out);
  assert.match(extra.out, /unexpected argument: "unexpected"/);
});

test("conformance honors the deploy-wide --config and --sandbox-dir flags", async () => {
  const deployDir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  const sandboxDir = mkdtempSync(join(tmpdir(), "qm-dispatch-sb-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "qm-dispatch-cwd-"));
  writeFileSync(
    join(deployDir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "flagged",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    }),
  );
  mkdirSync(join(sandboxDir, "skills", "greet"), { recursive: true });
  writeFileSync(join(sandboxDir, "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: says hi\n---\nbody\n");
  try {
    const positional = await run(["conformance", deployDir, "--static"], elsewhere);
    assert.equal(positional.exitCode, null, positional.out);
    assert.match(positional.out, /conformance — flagged/);

    const viaConfig = await run(["conformance", "--static", "--config", join(deployDir, CONFIG_FILENAME)], elsewhere);
    assert.equal(viaConfig.exitCode, null, viaConfig.out);
    assert.match(viaConfig.out, /conformance — flagged/);
    assert.match(viaConfig.out, /0 tools, 0 skills/, "layer defaults to <configDir>/sandbox, not cwd");

    const flagBeatsPositional = await run(
      ["conformance", elsewhere, "--static", "--config", join(deployDir, CONFIG_FILENAME)],
      elsewhere,
    );
    assert.equal(flagBeatsPositional.exitCode, null, flagBeatsPositional.out);
    assert.match(flagBeatsPositional.out, /conformance — flagged/);

    const viaSandbox = await run(
      ["conformance", "--static", "--config", join(deployDir, CONFIG_FILENAME), "--sandbox-dir", sandboxDir],
      elsewhere,
    );
    assert.equal(viaSandbox.exitCode, null, viaSandbox.out);
    assert.match(viaSandbox.out, /0 tools, 1 skills/);
  } finally {
    for (const d of [deployDir, sandboxDir, elsewhere]) rmSync(d, { recursive: true, force: true });
  }
});

test("config get prints raw scalars and JSON objects, honors --target, and fails loudly on unset paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-cfg-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    }),
  );
  try {
    const scalar = await run(["config", "get", "orgId"], dir);
    assert.equal(scalar.exitCode, null, scalar.out);
    assert.equal(scalar.out, "acme", "scalars print raw, with no quotes");

    const nested = await run(["config", "get", "sandbox.app"], dir);
    assert.equal(nested.out, "acme-sandboxes");

    const object = await run(["config", "get", "sandbox"], dir);
    assert.deepEqual(
      JSON.parse(object.out),
      { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
      "objects print as JSON",
    );

    const overridden = await run(["config", "get", "target", "--target", "fly"], dir);
    assert.equal(overridden.out, "fly", "--target overrides the config's durable value, same as every deploy command");

    const missing = await run(["config", "get", "aws.deployRoleArn"], dir);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.out, /"aws\.deployRoleArn" is not set/);

    const usage = await run(["config", "get"], dir);
    assert.equal(usage.exitCode, 2);
    assert.match(usage.out, /usage: qm config get/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--target revalidates the effective provider config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-target-validation-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { backend: "sprites", app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
    }),
  );
  try {
    const result = await run(["check", "--target", "aws"], dir);
    assert.equal(result.exitCode, 1);
    assert.match(result.out, /target "aws" requires an "aws" block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check --json routes failures on structured clause data, not message sniffing", async () => {
  const base = {
    contract: 1,
    orgId: "acme",
    publicUrl: "http://localhost:8080",
    target: "docker",
    services: ["core"],
    sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
  };
  const sandboxDir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(join(sandboxDir, CONFIG_FILENAME), JSON.stringify(base));
  mkdirSync(join(sandboxDir, "sandbox", "tools", "bad"), { recursive: true });
  writeFileSync(join(sandboxDir, "sandbox", "tools", "bad", "tool.json"), "{ nope");
  const awsDir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(awsDir, CONFIG_FILENAME),
    JSON.stringify({
      ...base,
      target: "aws",
      sandbox: { backend: "sprites", app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
      aws: {
        accountId: "123456789012",
        region: "us-west-2",
        cluster: "c",
        deployRoleArn: "arn:aws:iam::123456789012:role/d",
        secretsPrefix: "p/",
        imageLabel: "release",
        networking: { cloudMapNamespace: "n" },
        services: {
          core: { ecrRepository: "repo", ecsService: "s", cpu: 256, memory: 512 },
          ghost: { ecrRepository: "r2", ecsService: "s2", cpu: 256, memory: 512 },
        },
      },
    }),
  );
  const secretDir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(join(secretDir, CONFIG_FILENAME), JSON.stringify({ ...base, env: { core: { MY_API_KEY: "x" } } }));
  try {
    for (const [dir, clause] of [
      [sandboxDir, "sandbox.descriptors"],
      [awsDir, "config.v1"],
      [secretDir, "config.no-secret-values"],
    ] as const) {
      const { out, exitCode } = await run(["check", "--json"], dir);
      assert.equal(exitCode, 1, out);
      const result = JSON.parse(out) as { clauses: Record<string, unknown> };
      assert.deepEqual(Object.keys(result.clauses), [clause], out);
    }
  } finally {
    for (const dir of [sandboxDir, awsDir, secretDir]) rmSync(dir, { recursive: true, force: true });
  }
});

test("check --json groups a multi-clause failure under each error's own clause, without a header line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-dispatch-"));
  writeFileSync(
    join(dir, CONFIG_FILENAME),
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
      env: { core: { MY_API_KEY: "x" } },
    }),
  );
  mkdirSync(join(dir, "sandbox", "tools", "bad"), { recursive: true });
  writeFileSync(join(dir, "sandbox", "tools", "bad", "tool.json"), "{ nope");
  try {
    const { out, exitCode } = await run(["check", "--json"], dir);
    assert.equal(exitCode, 1, out);
    const result = JSON.parse(out) as { valid: boolean; clauses: Record<string, { status: string; errors: string[] }> };
    assert.equal(result.valid, false);
    assert.deepEqual(Object.keys(result.clauses).sort(), ["config.no-secret-values", "sandbox.descriptors"]);
    assert.match(result.clauses["config.no-secret-values"]!.errors.join("\n"), /core\.MY_API_KEY/);
    assert.match(result.clauses["sandbox.descriptors"]!.errors.join("\n"), /not valid JSON/);
    for (const clause of Object.values(result.clauses)) {
      assert.equal(clause.status, "fail");
      assert.ok(
        clause.errors.every((message) => !message.includes("check failed")),
        out,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
