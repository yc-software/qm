import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTaskDefinition } from "../scripts/aws/ecs-blue-green-drill.ts";
import { validateDrillIdentifier, verifyScript } from "../scripts/aws/rds-restore-drill.ts";

test("restore drills accept only scoped temporary database identifiers", () => {
  assert.equal(
    validateDrillIdentifier("acme-qm-core", "acme-qm-core-restore-drill-1234"),
    "acme-qm-core-restore-drill-1234",
  );
  for (const identifier of [
    "other-restore-drill-1234",
    "acme-qm-core",
    "acme-qm-core-restore-drill-1234;drop",
    `acme-qm-core-restore-drill-${"x".repeat(64)}`,
  ]) {
    assert.throws(() => validateDrillIdentifier("acme-qm-core", identifier));
  }
});

test("restore verification uses the task secret but replaces only its private host", () => {
  const script = verifyScript("restore.abc.us-west-2.rds.amazonaws.com");
  assert.match(script, /RESTORE_URL=.*DATABASE_URL/);
  assert.match(script, /RESTORE_HOST/);
  assert.match(script, /pg_isready/);
  assert.match(script, /SELECT COUNT\(\*\) FROM sessions/);
  assert.match(script, /qm_schema_migrations/);
  assert.doesNotMatch(script, /restore\.abc/);
  assert.throws(() => verifyScript("restore; echo compromised"));
});

test("blue/green drill preserves the deployed task contract and breaks only core health", () => {
  const source = {
    taskDefinitionArn: "arn:task:1",
    revision: 1,
    status: "ACTIVE",
    registeredAt: "today",
    family: "acme-core",
    cpu: "2048",
    memory: "4096",
    networkMode: "awsvpc",
    taskRoleArn: "arn:task-role",
    executionRoleArn: "arn:execution-role",
    requiresCompatibilities: ["FARGATE"],
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    containerDefinitions: [
      {
        name: "core",
        image: "core@sha256:abc",
        healthCheck: { command: ["CMD-SHELL", "curl /healthz"] },
      },
      {
        name: "sidecar",
        image: "sidecar@sha256:def",
        healthCheck: { command: ["CMD-SHELL", "true"] },
      },
    ],
  };
  const broken = brokenTaskDefinition(source);
  assert.equal(broken.taskDefinitionArn, undefined);
  assert.equal(broken.revision, undefined);
  assert.equal(broken.registeredAt, undefined);
  assert.equal(broken.family, "acme-core");
  const containers = broken.containerDefinitions as Array<Record<string, unknown>>;
  assert.deepEqual(containers[0]!.healthCheck, {
    command: ["CMD-SHELL", "exit 1"],
    interval: 5,
    timeout: 2,
    retries: 2,
    startPeriod: 0,
  });
  assert.deepEqual(containers[1], source.containerDefinitions[1]);
});
