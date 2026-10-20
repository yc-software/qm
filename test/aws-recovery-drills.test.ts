import { test } from "node:test";
import assert from "node:assert/strict";
import { brokenTaskDefinition } from "../scripts/aws/ecs-blue-green-drill.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QmConfig } from "../cli/src/config.ts";
import { deleteDrill, validateDrillIdentifier, verifyScript } from "../scripts/aws/rds-restore-drill.ts";

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

function fakeBin(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

test("restore verification points the task's database URL at the restored host and requires TLS", () => {
  const host = "restore.abc.us-west-2.rds.amazonaws.com";
  const script = verifyScript(host);
  assert.doesNotMatch(script, /restore\.abc/);
  assert.throws(() => verifyScript("restore; echo compromised"));
  for (const [databaseUrl, restoreUrl] of [
    [
      "postgres://qm:p%40ss@source.rds.amazonaws.com:5432/qm?sslmode=no-verify",
      `postgres://qm:p%40ss@source.rds.amazonaws.com:5432/qm?host=${host}&sslmode=require`,
    ],
    [
      "postgresql://qm:secret@source.rds.amazonaws.com/qm",
      `postgresql://qm:secret@source.rds.amazonaws.com/qm?host=${host}&sslmode=require`,
    ],
  ]) {
    const bin = mkdtempSync(join(tmpdir(), "rds-verify-"));
    fakeBin(bin, "pg_isready", `printf '%s\\n' "$1" > "${bin}/pg_isready.args"`);
    fakeBin(bin, "psql", `printf '%s\\n' "$1" >> "${bin}/psql.args"; echo 3`);
    const out = execFileSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, DATABASE_URL: databaseUrl, RESTORE_HOST: host },
    });
    assert.equal(out.trim(), "RDS_RESTORE_DRILL_OK");
    assert.equal(readFileSync(join(bin, "pg_isready.args"), "utf8"), `--dbname=${restoreUrl}\n`);
    assert.equal(readFileSync(join(bin, "psql.args"), "utf8"), `${restoreUrl}\n${restoreUrl}\n`);
  }
});

test("deleting a drill database that does not exist is a no-op, and an existing one is deleted", () => {
  const bin = mkdtempSync(join(tmpdir(), "rds-delete-"));
  const config = { target: "aws", aws: { region: "us-west-2" } } as unknown as QmConfig;
  const identifier = "acme-qm-core-restore-drill-1";
  const previous = process.env.AWS_BIN;
  process.env.AWS_BIN = join(bin, "aws");
  try {
    for (const instances of ["[]", `[{"DBInstanceIdentifier":"${identifier}"}]`]) {
      fakeBin(
        bin,
        "aws",
        `echo "$*" >> "${bin}/aws.calls"; [ "$2" = describe-db-instances ] && echo '{"DBInstances":${instances}}'; true`,
      );
      writeFileSync(join(bin, "aws.calls"), "");
      deleteDrill(config, identifier);
      const calls = readFileSync(join(bin, "aws.calls"), "utf8").trim().split("\n");
      assert.match(
        calls[0]!,
        new RegExp(`^rds describe-db-instances --filters Name=db-instance-id,Values=${identifier} `),
      );
      assert.equal(
        calls.some((call) => call.startsWith(`rds delete-db-instance --db-instance-identifier ${identifier} `)),
        instances !== "[]",
      );
    }
  } finally {
    if (previous === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = previous;
  }
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
