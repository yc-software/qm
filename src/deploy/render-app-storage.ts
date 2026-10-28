import { randomBytes } from "node:crypto";
import { renderJobCommand } from "../../cli/src/render-job-command.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { sleep } from "../util/async.ts";
import { uuidSchema } from "../util/ids.ts";
import { shq } from "../util/shell.ts";
import { createRenderApi, type RenderApi } from "./render-api.ts";

export interface StoredRenderAppStorage {
  deploymentId: string;
  accessKey: string;
  secretKeyEnc: string;
  enabled: boolean;
}

interface Job {
  id: string;
  status: string;
}

export function renderAppStoragePolicy(bucket: string, prefix: string) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-zA-Z0-9/_-]+\/$/.test(prefix))
    throw new Error("Render app storage requires a bucket and a safe object prefix");
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:GetBucketLocation"], Resource: [`arn:aws:s3:::${bucket}`] },
      {
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [`arn:aws:s3:::${bucket}`],
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
      {
        Effect: "Allow",
        Action: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        Resource: [`arn:aws:s3:::${bucket}/${prefix}*`],
      },
    ],
  };
}

export function createRenderAppStorage(opts: {
  apiKey: string;
  workspaceId: string;
  environmentId: string;
  minioServiceId: string;
  endpoint: string;
  bucket: string;
  prefix?: string;
  region?: string;
  store: DurableMap<StoredRenderAppStorage>;
  keyMaterial: string | Buffer;
  api?: RenderApi;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): { ensure(deploymentId: string, repair?: boolean): Promise<Record<string, string>> } {
  const endpoint = new URL(opts.endpoint);
  if (
    !opts.minioServiceId ||
    !opts.keyMaterial.length ||
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new Error("Render app storage requires a MinIO service and a valid endpoint");
  const key = deriveConnectorKey(opts.keyMaterial, "render-app-storage");
  const api = opts.api ?? createRenderApi(opts);
  const prefixFor = (id: string) => `${opts.prefix ?? ""}app-data/${id}/`;
  const path = `/services/${encodeURIComponent(opts.minioServiceId)}`;
  const poll = opts.pollIntervalMs ?? 2_000;

  async function provision(record: StoredRenderAppStorage): Promise<void> {
    const service = await api.request<{ ownerId: string; environmentId?: string; type: string }>("GET", path);
    if (
      service?.ownerId !== opts.workspaceId ||
      service.environmentId !== opts.environmentId ||
      service.type !== "web_service"
    )
      throw new Error("The MinIO service does not belong to this Render environment");
    const password = decryptSecret(record.secretKeyEnc, key);
    const policy = JSON.stringify(renderAppStoragePolicy(opts.bucket, prefixFor(record.deploymentId)));
    const script = `set -eu
umask 077
config=$(mktemp -d)
trap 'rm -rf "$config"' EXIT
unset MC_HOST_qm MC_CONFIG_ENV_FILE
run_mc() {
  if timeout -s TERM -k 5 30 mc --config-dir "$config" --no-color "$@" >/dev/null; then return; else status=$?; fi
  printf 'MinIO %s failed (exit %s)\\n' "$*" "$status" >&2
  return "$status"
}
printf '%s\\n%s\\n' "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" | run_mc alias set qm ${shq(endpoint.toString())} --api S3v4 --path on
printf '%s' ${shq(policy)} > "$config/policy.json"
printf '%s\\n' ${shq(password)} | run_mc admin user add qm ${shq(record.accessKey)}
run_mc admin user enable qm ${shq(record.accessKey)}
run_mc admin policy create qm ${shq(`qm-app-${record.accessKey}`)} "$config/policy.json"
run_mc admin policy attach qm ${shq(`qm-app-${record.accessKey}`)} --user ${shq(record.accessKey)} || {
  run_mc admin policy detach qm ${shq(`qm-app-${record.accessKey}`)} --user ${shq(record.accessKey)}
  run_mc admin policy attach qm ${shq(`qm-app-${record.accessKey}`)} --user ${shq(record.accessKey)}
}
printf 'QM app storage enable applied\\n'
`;
    const startCommand = renderJobCommand(script, "/bin/sh");
    const job = await api.request<Job>("POST", `${path}/jobs`, { startCommand });
    if (!job?.id) throw new Error("Render did not return an app storage job ID");
    const status = await wait(job.id);
    if (status !== "succeeded") throw new Error(`Render app storage job ${job.id} ${status}`);
    if (!record.enabled) await opts.store.put(record.deploymentId, { ...record, enabled: true });
  }

  async function wait(jobId: string): Promise<string> {
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      const job = await api.request<Job>("GET", `${path}/jobs/${encodeURIComponent(jobId)}`);
      if (job && ["succeeded", "failed", "canceled"].includes(job.status)) return job.status;
      await sleep(Math.max(1, poll));
    }
    throw new Error(`Render app storage job ${jobId} is still pending`);
  }

  return {
    async ensure(deploymentId, repair = false) {
      if (!uuidSchema.lowercase().safeParse(deploymentId).success)
        throw new Error("Render app storage requires a deployment UUID");
      let record = await opts.store.get(deploymentId);
      if (!record)
        record = await opts.store.putIfAbsent(deploymentId, {
          deploymentId,
          accessKey: randomBytes(10).toString("hex").toUpperCase(),
          secretKeyEnc: encryptSecret(randomBytes(30).toString("base64url"), key),
          enabled: false,
        });
      if (record.deploymentId !== deploymentId) throw new Error("Render app storage identity does not match");
      if (repair || !record.enabled) await provision(record);
      return {
        AWS_ACCESS_KEY_ID: record.accessKey,
        AWS_SECRET_ACCESS_KEY: decryptSecret(record.secretKeyEnc, key),
        AWS_REGION: opts.region ?? "us-east-1",
        AWS_ENDPOINT_URL_S3: endpoint.toString(),
        AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
        S3_FORCE_PATH_STYLE: "true",
        S3_BUCKET: opts.bucket,
        S3_PREFIX: prefixFor(deploymentId),
      };
    },
  };
}
