#!/usr/bin/env bash
set -euo pipefail

aws_bin="${AWS_BIN:-aws}"
database="${PREDEPLOY_DB_INSTANCE:?PREDEPLOY_DB_INSTANCE is required}"
minimum_retention="${PREDEPLOY_MIN_RETENTION_DAYS:-35}"
run_id="${GITHUB_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
snapshot="${PREDEPLOY_SNAPSHOT_ID:-${database}-predeploy-${run_id}-${run_attempt}}"
maximum_snapshots="${PREDEPLOY_MAX_MANUAL_SNAPSHOTS:-20}"

if [[ ! "$minimum_retention" =~ ^[0-9]+$ ]]; then
  echo "PREDEPLOY_MIN_RETENTION_DAYS must be a non-negative integer." >&2
  exit 1
fi
if [[ ! "$maximum_snapshots" =~ ^[1-9][0-9]*$ ]]; then
  echo "PREDEPLOY_MAX_MANUAL_SNAPSHOTS must be a positive integer." >&2
  exit 1
fi

read -r status retention < <(
  "$aws_bin" rds describe-db-instances \
    --db-instance-identifier "$database" \
    --query 'DBInstances[0].[DBInstanceStatus,BackupRetentionPeriod]' \
    --output text
)

if [[ "$status" != "available" ]]; then
  echo "Database $database is $status; refusing to deploy without an available source for the snapshot." >&2
  exit 1
fi
if [[ ! "$retention" =~ ^[0-9]+$ ]] || (( retention < minimum_retention )); then
  echo "Database $database has $retention days of point-in-time retention; at least $minimum_retention are required." >&2
  exit 1
fi

if "$aws_bin" rds describe-db-snapshots --db-snapshot-identifier "$snapshot" >/dev/null 2>&1; then
  echo "Snapshot $snapshot already exists; waiting for it to become available."
else
  "$aws_bin" rds create-db-snapshot \
    --db-instance-identifier "$database" \
    --db-snapshot-identifier "$snapshot" \
    --tags \
      Key=purpose,Value=predeploy \
      Key=git-sha,Value="${GITHUB_SHA:-unknown}" \
      Key=github-run,Value="$run_id"
fi

"$aws_bin" rds wait db-snapshot-available --db-snapshot-identifier "$snapshot"
"$aws_bin" rds describe-db-snapshots \
  --db-snapshot-identifier "$snapshot" \
  --query 'DBSnapshots[0].[DBSnapshotIdentifier,Status,SnapshotCreateTime]' \
  --output text

read -r -a snapshots < <(
  "$aws_bin" rds describe-db-snapshots \
    --db-instance-identifier "$database" \
    --snapshot-type manual \
    --query "reverse(sort_by(DBSnapshots[?starts_with(DBSnapshotIdentifier, \`${database}-predeploy-\`)], &SnapshotCreateTime))[].DBSnapshotIdentifier" \
    --output text
)
for ((i = maximum_snapshots; i < ${#snapshots[@]}; i++)); do
  "$aws_bin" rds delete-db-snapshot --db-snapshot-identifier "${snapshots[$i]}"
done

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "snapshot_id=$snapshot" >> "$GITHUB_OUTPUT"
fi
