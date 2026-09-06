import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("temporary restore drills do not create their own automated backup chain", () => {
  const source = readFileSync(new URL("../scripts/aws/rds-restore-drill.ts", import.meta.url), "utf8");
  assert.match(source, /"--backup-retention-period",\s*"0"/);
});

test("database recovery drills restore the deployment manifest point, not an ad hoc snapshot", () => {
  const source = readFileSync(new URL("../scripts/aws/rds-restore-drill.ts", import.meta.url), "utf8");
  assert.match(source, /deployment\/current/);
  assert.match(source, /dbRestorePoint/);
  assert.match(source, /restore-db-instance-to-point-in-time/);
  assert.match(source, /--source-db-instance-identifier/);
  assert.match(source, /--restore-time/);
  assert.match(source, /EarliestRestorableTime/);
  assert.match(source, /LatestRestorableTime/);
  assert.doesNotMatch(source, /restore-db-instance-from-db-snapshot|--db-snapshot-identifier/);
});

test("blue/green drill preserves the deployed task contract and breaks only core health", () => {
  const source = {
    taskDefinitionArn: "arn:task:1",
    revision: 1,
    status: "ACTIVE",
    registeredAt: "today",
    family: "yc-core",
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
  assert.equal(broken.family, "yc-core");
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

test("blue/green recovery trusts the native rollback verdict, not the stale legacy deployment list", () => {
  const source = readFileSync(new URL("../scripts/aws/ecs-blue-green-drill.ts", import.meta.url), "utf8");
  assert.match(source, /await waitForRollback/);
  assert.match(source, /await waitForHealthyService/);
  assert.match(source, /assertSettledHealthyBlueGreen/);
  assert.match(source, /failed task set has not finished draining/);
  assert.match(source, /baseline is not fully settled/);
  assert.match(source, /no successful circuit-breaker-enabled rollback candidate/);
  assert.match(source, /restoring the original task definition/);
  assert.doesNotMatch(source, /"wait", "services-stable"/);
});
