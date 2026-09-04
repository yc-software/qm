import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAwsTaskDefinitions } from "../src/commands/infra.ts";
import type { QmConfig } from "../src/config.ts";

const config: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "https://agent.acme.example",
  target: "aws",
  services: ["core", "web-ui"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
  aws: {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme-qm",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/qm/",
    imageLabel: "release",
    networking: { cloudMapNamespace: "acme.internal" },
    services: {
      core: { ecrRepository: "acme-core", ecsService: "acme-core", cpu: 2048, memory: 4096 },
      "web-ui": { ecrRepository: "acme-web", ecsService: "acme-web", cpu: 256, memory: 512 },
    },
  },
};

function fakeAws(
  dir: string,
  account = "123456789012",
  failDeletes = false,
  deployment = "acme",
): { bin: string; log: string } {
  const bin = join(dir, "aws-fake");
  const log = join(dir, "aws.log");
  writeFileSync(log, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const text = args.join(" ");
fs.appendFileSync(${JSON.stringify(log)}, text + "\\n");
const after = (flag) => args[args.indexOf(flag) + 1];
const arn = (family, revision) => "arn:aws:ecs:us-west-2:123456789012:task-definition/" + family + ":" + revision;
if (text.includes("sts get-caller-identity")) console.log(${JSON.stringify(account)});
else if (text.includes("ecs list-task-definitions")) {
  const family = after("--family-prefix");
  const status = after("--status");
  let taskDefinitionArns = [];
  if (family === "acme-core" && status === "ACTIVE") taskDefinitionArns = [...Array(12)].map((_, i) => arn(family, i + 1)).concat(arn(family, 30), arn("acme-core-extra", 99));
  if (family === "acme-core" && status === "INACTIVE") taskDefinitionArns = [arn(family, 20), arn(family, 21), arn(family, 22), arn("acme-core-old", 1)];
  if (family === "acme-web" && status === "INACTIVE") taskDefinitionArns = [arn(family, 3)];
  console.log(JSON.stringify({ taskDefinitionArns }));
} else if (text.includes("ecs delete-task-definitions")) {
  if (${JSON.stringify(failDeletes)}) console.log(JSON.stringify({ failures: [{ arn: arn("acme-core", 1), reason: "TASK_ECS_SERVICE_REFERENCE" }] }));
  else console.log(JSON.stringify({ failures: [] }));
} else if (text.includes("ecs list-tags-for-resource")) {
  console.log(JSON.stringify({ tags: [{ key: "ManagedBy", value: "qm-cli" }, { key: "Deployment", value: ${JSON.stringify(deployment)} }] }));
} else console.log("{}");
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

test("infra delete-task-definitions removes every revision of exact configured families in API-sized batches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-infra-task-definitions-"));
  const fake = fakeAws(dir);
  const prior = process.env.AWS_BIN;
  process.env.AWS_BIN = fake.bin;
  try {
    await deleteAwsTaskDefinitions(config);
    const calls = readFileSync(fake.log, "utf8").split("\n").filter(Boolean);
    const deregistrations = calls.filter((call) => call.includes("ecs deregister-task-definition"));
    assert.equal(deregistrations.length, 13);
    assert.ok(
      deregistrations.every((call) => call.includes("task-definition/acme-core:") && !call.includes("acme-core-extra")),
    );
    const deletions = calls.filter((call) => call.includes("ecs delete-task-definitions"));
    assert.equal(deletions.length, 3);
    assert.deepEqual(
      deletions.map((call) => call.match(/task-definition\//g)?.length),
      [10, 6, 1],
    );
    assert.ok(deletions.every((call) => !call.includes("acme-core-extra") && !call.includes("acme-core-old")));
    assert.ok(calls.indexOf(deregistrations[0]!) > calls.findIndex((call) => call.includes("sts get-caller-identity")));
    assert.ok(
      calls.findIndex((call) => call.includes("dynamodb delete-item")) >
        calls.findIndex((call) => call.includes("ecs delete-task-definitions")),
    );
  } finally {
    if (prior === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("infra delete-task-definitions surfaces per-revision deletion failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-infra-task-definitions-"));
  const fake = fakeAws(dir, "123456789012", true);
  const prior = process.env.AWS_BIN;
  process.env.AWS_BIN = fake.bin;
  try {
    await assert.rejects(
      () => deleteAwsTaskDefinitions(config),
      /failed to delete task definitions: .*acme-core:1 \(TASK_ECS_SERVICE_REFERENCE\)/,
    );
    assert.match(readFileSync(fake.log, "utf8"), /dynamodb delete-item/);
  } finally {
    if (prior === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("infra delete-task-definitions checks the exact AWS account before listing or mutating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-infra-task-definitions-"));
  const fake = fakeAws(dir, "999999999999");
  const prior = process.env.AWS_BIN;
  process.env.AWS_BIN = fake.bin;
  try {
    await assert.rejects(() => deleteAwsTaskDefinitions(config), /AWS account mismatch/);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /sts get-caller-identity/);
    assert.doesNotMatch(calls, /ecs |dynamodb /);
  } finally {
    if (prior === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("infra delete-task-definitions refuses foreign exact-name families before mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-infra-task-definitions-"));
  const fake = fakeAws(dir, "123456789012", false, "other");
  const prior = process.env.AWS_BIN;
  process.env.AWS_BIN = fake.bin;
  try {
    await assert.rejects(() => deleteAwsTaskDefinitions(config), /ownership tags do not match deployment acme/);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /deregister-task-definition|delete-task-definitions/);
  } finally {
    if (prior === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
