import { loadConfig } from "../config.ts";
import { s3Client } from "../persistence/s3.ts";
import { waitUntilBucketExists, type S3Client } from "@aws-sdk/client-s3";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BUCKET_DEADLINE_SECONDS = 120;

export async function awaitBucket(
  client: S3Client,
  bucket: string,
  maxWaitTime = BUCKET_DEADLINE_SECONDS,
): Promise<void> {
  try {
    await waitUntilBucketExists({ client, maxWaitTime, minDelay: 1, maxDelay: 1 }, { Bucket: bucket });
  } catch (cause) {
    throw new Error("The S3 endpoint did not accept the QM bucket credentials before the startup deadline", { cause });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  if (config.s3Endpoint) {
    const bucket = config.s3Bucket;
    const endpoint = config.s3Endpoint;
    if (!bucket) throw new Error("A custom S3 endpoint requires S3_BUCKET");
    const client = s3Client(config.s3Region ?? "us-east-1", { endpoint, maxAttempts: 1 });
    try {
      await awaitBucket(client, bucket);
    } finally {
      client.destroy();
    }
  }
  await import("../index.ts");
}
