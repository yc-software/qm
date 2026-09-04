import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const snapshotScript = resolve("scripts/predeploy-db-snapshot.sh");

function setupAws(): { dir: string; aws: string; log: string; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "predeploy-db-snapshot-"));
  const aws = join(dir, "aws");
  const log = join(dir, "calls");
  const output = join(dir, "github-output");
  writeFileSync(
    aws,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_AWS_LOG"
case "$1 $2" in
  "rds describe-db-instances")
    printf '%s\\t%s\\n' "\${FAKE_DB_STATUS:-available}" "\${FAKE_RETENTION:-35}"
    ;;
  "rds describe-db-snapshots")
    [[ -f "$FAKE_SNAPSHOT_STATE" || "\${FAKE_EXISTING:-}" == "true" ]] || exit 254
    if [[ "$*" == *"--snapshot-type manual"* ]]; then
      printf '%s\\n' "\${FAKE_SNAPSHOT_LIST:-\${PREDEPLOY_SNAPSHOT_ID:-test-snapshot}}"
    elif [[ "$*" == *"--query"* ]]; then
      printf '%s\\tavailable\\t2026-07-24T00:00:00Z\\n' "\${PREDEPLOY_SNAPSHOT_ID:-test-snapshot}"
    fi
    ;;
  "rds create-db-snapshot")
    touch "$FAKE_SNAPSHOT_STATE"
    ;;
  "rds delete-db-snapshot")
    ;;
  "rds wait")
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  chmodSync(aws, 0o755);
  return { dir, aws, log, output };
}

function envFor(fake: ReturnType<typeof setupAws>, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_BIN: fake.aws,
    FAKE_AWS_LOG: fake.log,
    FAKE_SNAPSHOT_STATE: join(fake.dir, "snapshot-state"),
    PREDEPLOY_DB_INSTANCE: "qm-prod-core",
    PREDEPLOY_SNAPSHOT_ID: "test-snapshot",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: "abc123",
    GITHUB_OUTPUT: fake.output,
    ...extra,
  };
}

test("creates and waits for a predeploy snapshot after checking retention", () => {
  const fake = setupAws();

  execFileSync("bash", [snapshotScript], { env: envFor(fake), encoding: "utf8" });

  const calls = readFileSync(fake.log, "utf8");
  assert.match(calls, /describe-db-instances --db-instance-identifier qm-prod-core/);
  assert.match(
    calls,
    /create-db-snapshot --db-instance-identifier qm-prod-core --db-snapshot-identifier test-snapshot/,
  );
  assert.match(calls, /Key=purpose,Value=predeploy Key=git-sha,Value=abc123 Key=github-run,Value=123/);
  assert.match(calls, /wait db-snapshot-available --db-snapshot-identifier test-snapshot/);
  assert.equal(readFileSync(fake.output, "utf8").trim(), "snapshot_id=test-snapshot");
});

test("reuses an existing snapshot on a workflow retry", () => {
  const fake = setupAws();

  execFileSync("bash", [snapshotScript], { env: envFor(fake, { FAKE_EXISTING: "true" }), encoding: "utf8" });

  const calls = readFileSync(fake.log, "utf8");
  assert.doesNotMatch(calls, /create-db-snapshot/);
  assert.match(calls, /wait db-snapshot-available/);
});

test("keeps only the newest configured number of predeploy snapshots", () => {
  const fake = setupAws();

  execFileSync("bash", [snapshotScript], {
    env: envFor(fake, {
      FAKE_EXISTING: "true",
      FAKE_SNAPSHOT_LIST: "newest second oldest",
      PREDEPLOY_MAX_MANUAL_SNAPSHOTS: "2",
    }),
    encoding: "utf8",
  });

  const calls = readFileSync(fake.log, "utf8");
  assert.match(calls, /starts_with\(DBSnapshotIdentifier, `qm-prod-core-predeploy-`\)/);
  assert.match(calls, /delete-db-snapshot --db-snapshot-identifier oldest/);
  assert.doesNotMatch(calls, /delete-db-snapshot --db-snapshot-identifier (newest|second)/);
});

test("refuses to deploy with less than 35 days of point-in-time retention", () => {
  const fake = setupAws();

  const result = spawnSync("bash", [snapshotScript], {
    env: envFor(fake, { FAKE_RETENTION: "7" }),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /at least 35 are required/);
  assert.doesNotMatch(readFileSync(fake.log, "utf8"), /create-db-snapshot/);
});

test("refuses to snapshot a database that is not available", () => {
  const fake = setupAws();

  const result = spawnSync("bash", [snapshotScript], {
    env: envFor(fake, { FAKE_DB_STATUS: "backing-up" }),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is backing-up/);
  assert.doesNotMatch(readFileSync(fake.log, "utf8"), /create-db-snapshot/);
});

test("refuses an invalid manual snapshot cap before calling AWS", () => {
  const fake = setupAws();

  const result = spawnSync("bash", [snapshotScript], {
    env: envFor(fake, { PREDEPLOY_MAX_MANUAL_SNAPSHOTS: "0" }),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be a positive integer/);
  assert.throws(() => readFileSync(fake.log, "utf8"));
});
