import { loadConfigAt, type QmConfig } from "../../cli/src/config.ts";
import { assertAwsCaller, awsJson, awsText, discoverCoreTask, requireAwsConfig, runCoreOneOff } from "./deployment.ts";

const POSTGRES_IMAGE = "public.ecr.aws/docker/library/postgres:16";

interface Args {
  command: "restore" | "verify" | "delete";
  configPath: string;
  identifier: string;
  host?: string;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0];
  if (command !== "restore" && command !== "verify" && command !== "delete") {
    throw new Error(
      "usage: rds-restore-drill.ts restore|verify|delete --config <file> --identifier <id> [--host <host>] --yes",
    );
  }
  let configPath = "";
  let identifier = "";
  let host: string | undefined;
  let yes = false;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    const value = argv[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--config") configPath = value;
    else if (arg === "--identifier") identifier = value;
    else if (arg === "--host") host = value;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!configPath || !identifier || !yes) throw new Error("--config, --identifier, and --yes are required");
  if (command === "restore" && host) throw new Error("restore does not accept --host");
  if (command === "verify" && !host) throw new Error("verify requires --host");
  if (command === "delete" && host) throw new Error("delete does not accept --host");
  return {
    command,
    configPath,
    identifier,
    ...(host ? { host } : {}),
  };
}

function sourceIdentifier(config: QmConfig): string {
  const aws = requireAwsConfig(config);
  return aws.rdsInstance ?? `${aws.cluster}-core`;
}

export function validateDrillIdentifier(source: string, identifier: string): string {
  const prefix = `${source}-restore-drill-`;
  if (
    identifier.length > 63 ||
    !identifier.startsWith(prefix) ||
    !/^[a-z][a-z0-9-]*[a-z0-9]$/.test(identifier) ||
    identifier.includes("--")
  ) {
    throw new Error(`restore drill identifier must match ${prefix}<run>`);
  }
  return identifier;
}

function validateEndpoint(host: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z0-9-]{1,63}$/.test(host)) {
    throw new Error(`invalid restore endpoint ${JSON.stringify(host)}`);
  }
  return host;
}

export function verifyScript(host: string): string {
  validateEndpoint(host);
  return [
    "set -eu",
    `RESTORE_URL=$(printf %s "$DATABASE_URL" | sed -E "s#^((postgres|postgresql)://[^@]+@)[^/:?]+#\\1$RESTORE_HOST#; s/sslmode=no-verify/sslmode=require/")`,
    `pg_isready --dbname="$RESTORE_URL"`,
    `test "$(psql "$RESTORE_URL" -Atc 'SELECT COUNT(*) FROM sessions')" -gt 0`,
    `test "$(psql "$RESTORE_URL" -Atc "SELECT COUNT(*) FROM qm_schema_migrations")" -gt 0`,
    "echo RDS_RESTORE_DRILL_OK",
  ].join(" && ");
}

function sourceFacts(config: QmConfig): {
  subnetGroup: string;
  securityGroups: string[];
  instanceClass: string;
  earliestRestorableTime: string;
  latestRestorableTime: string;
} {
  const source = sourceIdentifier(config);
  const described = awsJson<{
    DBInstances?: Array<{
      DBInstanceStatus?: string;
      DBInstanceClass?: string;
      StorageEncrypted?: boolean;
      PubliclyAccessible?: boolean;
      EarliestRestorableTime?: string;
      LatestRestorableTime?: string;
      DBSubnetGroup?: { DBSubnetGroupName?: string };
      VpcSecurityGroups?: Array<{ VpcSecurityGroupId?: string }>;
    }>;
  }>(config, ["rds", "describe-db-instances", "--db-instance-identifier", source]);
  const db = described.DBInstances?.[0];
  const subnetGroup = db?.DBSubnetGroup?.DBSubnetGroupName;
  const securityGroups = db?.VpcSecurityGroups?.flatMap((group) =>
    group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
  );
  if (
    db?.DBInstanceStatus !== "available" ||
    !db.DBInstanceClass ||
    !db.StorageEncrypted ||
    db.PubliclyAccessible ||
    !db.EarliestRestorableTime ||
    !db.LatestRestorableTime ||
    !subnetGroup ||
    !securityGroups?.length
  ) {
    throw new Error(`source database ${source} is not an available, encrypted, private VPC database`);
  }
  return {
    subnetGroup,
    securityGroups,
    instanceClass: db.DBInstanceClass,
    earliestRestorableTime: db.EarliestRestorableTime,
    latestRestorableTime: db.LatestRestorableTime,
  };
}

function currentRestorePoint(config: QmConfig): string {
  const aws = requireAwsConfig(config);
  const table = `${aws.cluster}-deploy-locks`;
  const pointer = awsJson<{ Item?: { manifestId?: { S?: string } } }>(config, [
    "dynamodb",
    "get-item",
    "--table-name",
    table,
    "--key",
    JSON.stringify({ lockKey: { S: "deployment/current" } }),
    "--consistent-read",
  ]);
  const manifestId = pointer.Item?.manifestId?.S;
  if (!manifestId) throw new Error("current deployment manifest pointer is missing");
  const stored = awsJson<{ Item?: { manifest?: { S?: string } } }>(config, [
    "dynamodb",
    "get-item",
    "--table-name",
    table,
    "--key",
    JSON.stringify({ lockKey: { S: `deployment/manifest/${manifestId}` } }),
    "--consistent-read",
  ]);
  let restorePoint: unknown;
  try {
    restorePoint = JSON.parse(stored.Item?.manifest?.S ?? "").dbRestorePoint;
  } catch {
    throw new Error(`deployment manifest ${manifestId} is invalid`);
  }
  if (
    typeof restorePoint !== "string" ||
    !Number.isFinite(Date.parse(restorePoint)) ||
    new Date(restorePoint).toISOString() !== restorePoint
  ) {
    throw new Error(`deployment manifest ${manifestId} has no valid point-in-time restore point`);
  }
  return restorePoint;
}

function restore(config: QmConfig, identifier: string): string {
  const source = sourceIdentifier(config);
  const restorePoint = currentRestorePoint(config);
  const facts = sourceFacts(config);
  const restoreTime = Date.parse(restorePoint);
  if (restoreTime < Date.parse(facts.earliestRestorableTime) || restoreTime > Date.parse(facts.latestRestorableTime)) {
    throw new Error(
      `deployment restore point ${restorePoint} is outside the available ${facts.earliestRestorableTime}–${facts.latestRestorableTime} window`,
    );
  }
  awsText(config, [
    "rds",
    "restore-db-instance-to-point-in-time",
    "--source-db-instance-identifier",
    source,
    "--target-db-instance-identifier",
    identifier,
    "--restore-time",
    restorePoint,
    "--db-instance-class",
    facts.instanceClass,
    "--db-subnet-group-name",
    facts.subnetGroup,
    "--vpc-security-group-ids",
    ...facts.securityGroups,
    "--no-multi-az",
    "--no-publicly-accessible",
    "--no-deletion-protection",
    "--backup-retention-period",
    "0",
    "--tags",
    "Key=purpose,Value=restore-drill",
    `Key=source-restore-point,Value=${restorePoint}`,
    `Key=github-run,Value=${process.env.GITHUB_RUN_ID ?? "local"}`,
  ]);
  awsText(config, ["rds", "wait", "db-instance-available", "--db-instance-identifier", identifier]);
  const endpoint = awsText(config, [
    "rds",
    "describe-db-instances",
    "--db-instance-identifier",
    identifier,
    "--query",
    "DBInstances[0].Endpoint.Address",
    "--output",
    "text",
  ]);
  return validateEndpoint(endpoint);
}

async function verify(config: QmConfig, host: string): Promise<void> {
  const facts = discoverCoreTask(config);
  await runCoreOneOff(config, facts, {
    label: "rds-restore-drill",
    image: POSTGRES_IMAGE,
    command: verifyScript(host),
    needsDatabase: true,
    environment: { RESTORE_HOST: host },
  });
}

function deleteDrill(config: QmConfig, identifier: string): void {
  const described = awsJson<{
    DBInstances?: Array<{ DBInstanceIdentifier?: string }>;
  }>(config, ["rds", "describe-db-instances", "--db-instance-identifier", identifier]);
  if (!described.DBInstances?.length) return;
  awsText(config, [
    "rds",
    "delete-db-instance",
    "--db-instance-identifier",
    identifier,
    "--skip-final-snapshot",
    "--delete-automated-backups",
  ]);
  awsText(config, ["rds", "wait", "db-instance-deleted", "--db-instance-identifier", identifier]);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const { config } = loadConfigAt(args.configPath);
  assertAwsCaller(config);
  const identifier = validateDrillIdentifier(sourceIdentifier(config), args.identifier);
  if (args.command === "restore") {
    const endpoint = restore(config, identifier);
    console.log(`RESTORE_ENDPOINT=${endpoint}`);
  } else if (args.command === "verify") {
    await verify(config, args.host!);
  } else {
    try {
      deleteDrill(config, identifier);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/DBInstanceNotFound/.test(message)) throw error;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
