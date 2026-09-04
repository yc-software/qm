import { randomUUID } from "node:crypto";
import type { AwsConfig } from "./config.ts";
import { CliError, errMessage, warn } from "./log.ts";
import { capture, envNum } from "./util.ts";

const LEASE_SECONDS = 60 * 60;

export interface AwsLease {
  table: string;
  key: string;
  holder: string;
  releaseOnSignal?: () => void;
  renewTimer?: ReturnType<typeof setInterval>;
}

export function awsText(aws: AwsConfig, args: string[]): string {
  return capture(process.env.AWS_BIN ?? "aws", [...args, "--region", aws.region, "--output", "text"]).trim();
}

export function deployLocksTable(aws: AwsConfig): string {
  return `${aws.cluster}-deploy-locks`;
}

export function acquireAwsLease(aws: AwsConfig, key = "deploy"): AwsLease {
  const table = deployLocksTable(aws);
  const holder = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    awsText(aws, [
      "dynamodb",
      "put-item",
      "--table-name",
      table,
      "--item",
      JSON.stringify({ lockKey: { S: key }, holder: { S: holder }, expiresAt: { N: String(now + LEASE_SECONDS) } }),
      "--condition-expression",
      "attribute_not_exists(lockKey) OR expiresAt < :now",
      "--expression-attribute-values",
      JSON.stringify({ ":now": { N: String(now) } }),
    ]);
  } catch (error) {
    if (/ConditionalCheckFailedException/.test(errMessage(error))) {
      throw new CliError(
        `another QM operation holds the ${JSON.stringify(key)} lease in ${table}; it expires within ${LEASE_SECONDS / 60} minutes, or delete that item to release it manually`,
      );
    }
    throw error;
  }
  const lease: AwsLease = { table, key, holder };
  const onSignal = (): void => {
    releaseAwsLease(aws, lease);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  lease.releaseOnSignal = () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  lease.renewTimer = setInterval(
    () => renewAwsLease(aws, lease),
    envNum("QM_AWS_LEASE_RENEW_MS", (LEASE_SECONDS / 3) * 1000),
  );
  lease.renewTimer.unref();
  return lease;
}

function renewAwsLease(aws: AwsConfig, lease: AwsLease): void {
  const now = Math.floor(Date.now() / 1000);
  try {
    awsText(aws, [
      "dynamodb",
      "update-item",
      "--table-name",
      lease.table,
      "--key",
      JSON.stringify({ lockKey: { S: lease.key } }),
      "--update-expression",
      "SET expiresAt = :expiresAt",
      "--condition-expression",
      "holder = :holder",
      "--expression-attribute-values",
      JSON.stringify({ ":expiresAt": { N: String(now + LEASE_SECONDS) }, ":holder": { S: lease.holder } }),
    ]);
  } catch (error) {
    if (/ConditionalCheckFailedException/.test(errMessage(error))) {
      clearInterval(lease.renewTimer);
      lease.renewTimer = undefined;
      warn(
        `the ${JSON.stringify(lease.key)} lease in ${lease.table} was taken over by another QM operation; this run no longer holds it and a concurrent operation may be mutating the stack`,
      );
    } else {
      warn(`could not renew the ${JSON.stringify(lease.key)} lease in ${lease.table}: ${errMessage(error)}`);
    }
  }
}

export function releaseAwsLease(aws: AwsConfig, lease: AwsLease): void {
  if (lease.renewTimer) clearInterval(lease.renewTimer);
  lease.renewTimer = undefined;
  lease.releaseOnSignal?.();
  lease.releaseOnSignal = undefined;
  try {
    awsText(aws, [
      "dynamodb",
      "delete-item",
      "--table-name",
      lease.table,
      "--key",
      JSON.stringify({ lockKey: { S: lease.key } }),
      "--condition-expression",
      "holder = :holder",
      "--expression-attribute-values",
      JSON.stringify({ ":holder": { S: lease.holder } }),
    ]);
  } catch (error) {
    warn(`could not release AWS lease: ${(error as Error).message}`);
  }
}

export async function withAwsLease<T>(aws: AwsConfig, operation: (lease: AwsLease) => Promise<T>): Promise<T> {
  const lease = acquireAwsLease(aws);
  try {
    return await operation(lease);
  } finally {
    releaseAwsLease(aws, lease);
  }
}
