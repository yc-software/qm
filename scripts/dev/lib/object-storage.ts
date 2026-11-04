import { createHash } from "node:crypto";
import { run } from "./proc.ts";
import { ensureDockerDaemon } from "./postgres.ts";
import { sleep } from "./util.ts";

const MINIO_IMAGE =
  "cgr.dev/chainguard/minio@sha256:4d397a26fe49d7f9ed39b8b566534848936f7efa50ab6328ac97b2a44eeabf4c";

function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return run("docker", args, { timeoutMs: 120_000 });
}

function worktreeBucket(worktree: string): string {
  return `qm-dev-${createHash("sha1").update(worktree).digest("hex").slice(0, 12)}`;
}

export interface LocalObjectStorage {
  env: Record<string, string>;
}

export async function ensureLocalObjectStorage(
  worktree: string,
  log: (message: string) => void,
): Promise<LocalObjectStorage> {
  const container = process.env.DEV_INSTANCE_MINIO_CONTAINER || "qm-dev-minio";
  const port = process.env.DEV_INSTANCE_MINIO_PORT || "59000";
  const image = process.env.DEV_INSTANCE_MINIO_IMAGE || MINIO_IMAGE;
  const accessKey = process.env.DEV_INSTANCE_MINIO_ACCESS_KEY || "qm-dev";
  const secretKey = process.env.DEV_INSTANCE_MINIO_SECRET_KEY || "qm-dev-secret-key";
  const volume = process.env.DEV_INSTANCE_MINIO_VOLUME || "qm-dev-minio-data";
  const bucket = worktreeBucket(worktree);
  if (!(await ensureDockerDaemon(log))) throw new Error("docker daemon unavailable");
  const exists = (
    await docker(["ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"])
  ).stdout.trim();
  if (!exists) {
    if ((await docker(["volume", "create", volume])).code !== 0) throw new Error("docker volume create failed");
    const started = await docker([
      "run",
      "-d",
      "--name",
      container,
      "-e",
      `MINIO_ROOT_USER=${accessKey}`,
      "-e",
      `MINIO_ROOT_PASSWORD=${secretKey}`,
      "-p",
      `127.0.0.1:${port}:9000`,
      "-v",
      `${volume}:/data`,
      image,
      "server",
      "--address",
      "0.0.0.0:9000",
      "/data",
    ]);
    if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr.trim()}`);
  } else if ((await docker(["inspect", "-f", "{{.State.Running}}", container])).stdout.trim() !== "true") {
    if ((await docker(["start", container])).code !== 0) throw new Error("docker start failed");
  }
  const localEndpoint = `http://127.0.0.1:${port}`;
  const publicEndpoint = process.env.DEV_INSTANCE_MINIO_PUBLIC_ENDPOINT || `http://host.docker.internal:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${localEndpoint}/minio/health/live`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch (error) {
      if (attempt === 59) throw error;
    }
    await sleep(1_000);
  }
  if (!ready) throw new Error(`MinIO container ${container} never became ready`);
  const { S3Client, CreateBucketCommand, HeadBucketCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: localEndpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
  log(`durability: using local MinIO container ${container} bucket ${bucket}`);
  return {
    env: {
      SNAPSHOT_STORE: "s3",
      S3_BUCKET: bucket,
      S3_REGION: "us-east-1",
      AWS_ENDPOINT_URL_S3: localEndpoint,
      S3_PUBLIC_ENDPOINT: publicEndpoint,
      AWS_ACCESS_KEY_ID: accessKey,
      AWS_SECRET_ACCESS_KEY: secretKey,
      AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
      AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED",
    },
  };
}
