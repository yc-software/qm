import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { withAwsLease } from "../aws-lease.ts";
import { updateConfigCoreEnv, type QmConfig } from "../config.ts";
import { CliError, ok, step } from "../log.ts";
import { awsObjectStoreBucket } from "../terraform.ts";
import { capture, sleep } from "../util.ts";
import { guardLambdaMicrovms } from "../backends/aws.ts";

interface ImageSummary {
  name: string;
  imageArn: string;
  state: string;
  latestActiveImageVersion?: string;
  latestFailedImageVersion?: string;
  tags?: Record<string, string>;
}

interface InfraWaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface MicrovmSummary {
  microvmId: string;
  state: string;
}

interface ImageVersionSummary {
  imageVersion: string;
  state: string;
  status?: string;
  stateReason?: string;
}

interface ObjectVersion {
  Key: string;
  VersionId: string;
}

interface ImageOperation extends ImageSummary {
  imageVersion?: string;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(body: Buffer): number {
  let value = 0xffffffff;
  for (const byte of body) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zipFiles(files: Array<{ name: string; body: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const compressed = deflateRawSync(file.body, { level: 9 });
    const checksum = crc32(file.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function asset(name: string): Buffer {
  const source = new URL(`../../templates/aws/microvm-agent/${name}`, import.meta.url);
  const packaged = new URL(`../../../templates/aws/microvm-agent/${name}`, import.meta.url);
  return readFileSync(existsSync(source) ? source : packaged);
}

export function microvmBuildArchive(): Buffer {
  return zipFiles([
    { name: "Dockerfile", body: asset("Dockerfile") },
    { name: "agent.mjs", body: asset("agent.mjs") },
  ]);
}

function imageList(awsBin: string, region: string, name: string): ImageSummary[] {
  const raw = capture(awsBin, [
    "lambda-microvms",
    "list-microvm-images",
    "--name-filter",
    name,
    "--region",
    region,
    "--output",
    "json",
    "--no-cli-pager",
  ]);
  const parsed = JSON.parse(raw) as { items?: ImageSummary[] };
  return parsed.items ?? [];
}

function configuredAws(
  config: QmConfig,
  operation: string,
): {
  aws: NonNullable<QmConfig["aws"]>;
  awsBin: string;
  imageName: string;
} {
  if (!config.aws || config.target !== "aws") throw new CliError(`${operation} is only available for target aws`);
  const imageName = config.env.core?.AWS_DEPLOY_IMAGE;
  if (!imageName) throw new CliError("env.core.AWS_DEPLOY_IMAGE is required");
  const awsBin = process.env.AWS_BIN ?? "aws";
  const account = capture(awsBin, [
    "sts",
    "get-caller-identity",
    "--query",
    "Account",
    "--output",
    "text",
    "--region",
    config.aws.region,
    "--no-cli-pager",
  ]).trim();
  if (account !== config.aws.accountId) {
    throw new CliError(`AWS account mismatch: config=${config.aws.accountId}, credentials=${account}`);
  }
  return { aws: config.aws, awsBin, imageName };
}

function configuredAwsAccount(
  config: QmConfig,
  operation: string,
): {
  aws: NonNullable<QmConfig["aws"]>;
  awsBin: string;
} {
  if (!config.aws || config.target !== "aws") throw new CliError(`${operation} is only available for target aws`);
  const awsBin = process.env.AWS_BIN ?? "aws";
  const account = capture(awsBin, [
    "sts",
    "get-caller-identity",
    "--query",
    "Account",
    "--output",
    "text",
    "--region",
    config.aws.region,
    "--no-cli-pager",
  ]).trim();
  if (account !== config.aws.accountId) {
    throw new CliError(`AWS account mismatch: config=${config.aws.accountId}, credentials=${account}`);
  }
  return { aws: config.aws, awsBin };
}

function taskDefinitionFamily(arn: string): string | undefined {
  const marker = ":task-definition/";
  const start = arn.indexOf(marker);
  if (start === -1) return undefined;
  return arn.slice(start + marker.length).replace(/:\d+$/, "");
}

function listTaskDefinitions(awsBin: string, region: string, family: string, status: "ACTIVE" | "INACTIVE"): string[] {
  const parsed = JSON.parse(
    capture(awsBin, [
      "ecs",
      "list-task-definitions",
      "--family-prefix",
      family,
      "--status",
      status,
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ]),
  ) as { taskDefinitionArns?: string[] };
  return (parsed.taskDefinitionArns ?? []).filter((arn) => taskDefinitionFamily(arn) === family);
}

function assertTaskDefinitionOwnership(config: QmConfig, awsBin: string, arn: string): void {
  const parsed = JSON.parse(
    capture(awsBin, [
      "ecs",
      "list-tags-for-resource",
      "--resource-arn",
      arn,
      "--region",
      config.aws!.region,
      "--output",
      "json",
      "--no-cli-pager",
    ]),
  ) as { tags?: Array<{ key?: string; value?: string }> };
  const tags = Object.fromEntries(
    (parsed.tags ?? []).flatMap((tag) => (tag.key && tag.value ? [[tag.key, tag.value] as const] : [])),
  );
  if (tags["Deployment"] !== config.orgId || !["qm-cli", "terraform"].includes(tags["ManagedBy"] ?? "")) {
    throw new CliError(
      `refusing to delete task definition ${arn}: ownership tags do not match deployment ${config.orgId}`,
    );
  }
}

export async function deleteAwsTaskDefinitions(config: QmConfig): Promise<void> {
  const { aws, awsBin } = configuredAwsAccount(config, "infra delete-task-definitions");
  await withAwsLease(aws, async () => {
    for (const family of [...new Set(Object.values(aws.services).map((service) => service.ecsService))].sort()) {
      const active = listTaskDefinitions(awsBin, aws.region, family, "ACTIVE");
      const inactive = listTaskDefinitions(awsBin, aws.region, family, "INACTIVE");
      const revisions = [...new Set([...active, ...inactive])];
      for (const arn of revisions) assertTaskDefinitionOwnership(config, awsBin, arn);
      for (const arn of active) {
        capture(awsBin, [
          "ecs",
          "deregister-task-definition",
          "--task-definition",
          arn,
          "--region",
          aws.region,
          "--output",
          "json",
          "--no-cli-pager",
        ]);
      }
      for (let index = 0; index < revisions.length; index += 10) {
        const deleted = JSON.parse(
          capture(awsBin, [
            "ecs",
            "delete-task-definitions",
            "--task-definitions",
            ...revisions.slice(index, index + 10),
            "--region",
            aws.region,
            "--output",
            "json",
            "--no-cli-pager",
          ]),
        ) as { failures?: Array<{ arn?: string; reason?: string; detail?: string }> };
        if (deleted.failures?.length) {
          throw new CliError(
            `failed to delete task definitions: ${deleted.failures.map((failure) => `${failure.arn ?? "unknown"} (${failure.reason ?? failure.detail ?? "unknown"})`).join(", ")}`,
          );
        }
      }
      ok(`deleted ${revisions.length} task definition revision${revisions.length === 1 ? "" : "s"} for ${family}`);
    }
  });
}

function findImage(awsBin: string, region: string, imageName: string): ImageSummary | undefined {
  return imageList(awsBin, region, imageName).find((image) => image.name === imageName);
}

function imageTags(awsBin: string, region: string, imageArn: string): Record<string, string> {
  const parsed = JSON.parse(
    capture(awsBin, [
      "lambda-microvms",
      "list-tags",
      "--resource",
      imageArn,
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ]),
  ) as { Tags?: Record<string, string> };
  return parsed.Tags ?? {};
}

function assertImageIdentity(config: QmConfig, awsBin: string, image: ImageSummary): ImageSummary {
  const expectedName = config.env.core!.AWS_DEPLOY_IMAGE!;
  const expectedArn = `arn:aws:lambda:${config.aws!.region}:${config.aws!.accountId}:microvm-image:${expectedName}`;
  if (image.name !== expectedName) throw new CliError(`refusing to manage unexpected MicroVM image name ${image.name}`);
  if (image.imageArn !== expectedArn)
    throw new CliError(`refusing to manage unexpected MicroVM image ARN ${image.imageArn}`);
  const tags = imageTags(awsBin, config.aws!.region, image.imageArn);
  if (tags["ManagedBy"] !== "qm-cli" || tags["Deployment"] !== config.orgId) {
    throw new CliError(
      `refusing to manage MicroVM image ${image.name}: ownership tags do not match deployment ${config.orgId}`,
    );
  }
  return { ...image, tags };
}

async function waitForSettledImage(
  awsBin: string,
  region: string,
  imageName: string,
  options: InfraWaitOptions,
): Promise<ImageSummary | undefined> {
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
  for (;;) {
    const image = findImage(awsBin, region, imageName);
    if (!image || !["CREATING", "UPDATING", "DELETING"].includes(image.state)) return image;
    if (now() >= deadline) throw new CliError(`timed out waiting for MicroVM image ${imageName}`);
    await wait(options.intervalMs ?? 10_000);
  }
}

function getImageVersion(awsBin: string, region: string, imageArn: string, imageVersion: string): ImageVersionSummary {
  return JSON.parse(
    capture(awsBin, [
      "lambda-microvms",
      "get-microvm-image-version",
      "--image-identifier",
      imageArn,
      "--image-version",
      imageVersion,
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ]),
  ) as ImageVersionSummary;
}

async function waitForImageVersion(
  awsBin: string,
  region: string,
  imageArn: string,
  imageVersion: string,
  options: InfraWaitOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
  for (;;) {
    const version = getImageVersion(awsBin, region, imageArn, imageVersion);
    if (version.imageVersion !== imageVersion) {
      throw new CliError(`MicroVM image version response changed from ${imageVersion} to ${version.imageVersion}`);
    }
    if (version.state === "SUCCESSFUL" && version.status === "ACTIVE") return;
    if (version.state === "FAILED") {
      throw new CliError(
        `MicroVM image version ${imageVersion} failed${version.stateReason ? `: ${version.stateReason}` : ""}`,
      );
    }
    if (["DELETING", "DELETED", "DELETE_FAILED"].includes(version.state)) {
      throw new CliError(`MicroVM image version ${imageVersion} entered unexpected state ${version.state}`);
    }
    if (now() >= deadline) throw new CliError(`timed out waiting for MicroVM image version ${imageVersion}`);
    await wait(options.intervalMs ?? 10_000);
  }
}

function recordImagePin(
  configPath: string,
  image: ImageSummary,
  version: string,
  executionRoleArn: string,
): { imageArn: string; version: string } {
  const raw = readFileSync(configPath, "utf8");
  writeFileSync(
    configPath,
    updateConfigCoreEnv(raw, {
      AWS_DEPLOY_IMAGE_VERSION: version,
      AWS_DEPLOY_EXEC_ROLE_ARN: executionRoleArn,
    }),
  );
  ok(`built ${image.imageArn} version ${version}`);
  ok("recorded AWS_DEPLOY_IMAGE_VERSION and AWS_DEPLOY_EXEC_ROLE_ARN in the QM deployment config");
  return { imageArn: image.imageArn, version };
}

export async function buildAwsMicrovmImage(
  config: QmConfig,
  configPath: string,
  options: InfraWaitOptions = {},
): Promise<{ imageArn: string; version: string }> {
  const configured = configuredAws(config, "infra build-image");
  return withAwsLease(configured.aws, () => buildAwsMicrovmImageLocked(config, configPath, options, configured)).catch(
    guardLambdaMicrovms,
  );
}

async function buildAwsMicrovmImageLocked(
  config: QmConfig,
  configPath: string,
  options: InfraWaitOptions,
  configured: ReturnType<typeof configuredAws>,
): Promise<{ imageArn: string; version: string }> {
  const { aws, awsBin, imageName } = configured;
  const archive = microvmBuildArchive();
  const digest = createHash("sha256").update(archive).digest("hex");
  const bucket = awsObjectStoreBucket(config);
  const key = `deployment/microvm-images/${digest}.zip`;
  const uri = `s3://${bucket}/${key}`;
  const buildRoleArn = `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-microvm-build`;
  const defaultExecutionRoleArn = `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-microvm-exec`;
  const executionRoleArn = config.env.core?.AWS_DEPLOY_EXEC_ROLE_ARN ?? defaultExecutionRoleArn;
  if (!new RegExp(`^arn:aws[a-z-]*:iam::${aws.accountId}:role/[A-Za-z0-9_+=,.@/-]+$`).test(executionRoleArn)) {
    throw new CliError("AWS_DEPLOY_EXEC_ROLE_ARN must name a role in the configured AWS account");
  }
  const baseImageArn = `arn:aws:lambda:${aws.region}:aws:microvm-image:al2023-1`;
  let existing = findImage(awsBin, aws.region, imageName);
  if (existing && existing.state !== "DELETED") existing = assertImageIdentity(config, awsBin, existing);
  if (existing && ["CREATING", "UPDATING"].includes(existing.state)) {
    step(`waiting for the in-progress ${imageName} image build before starting this build`);
    existing = await waitForSettledImage(awsBin, aws.region, imageName, options);
    if (existing && existing.state !== "DELETED") existing = assertImageIdentity(config, awsBin, existing);
  }
  if (existing?.state === "DELETING") {
    existing = await waitForSettledImage(awsBin, aws.region, imageName, options);
    if (existing && existing.state !== "DELETED") existing = assertImageIdentity(config, awsBin, existing);
  }
  if (existing?.state === "DELETE_FAILED") throw new CliError(`MicroVM image ${imageName} is in state DELETE_FAILED`);
  if (existing?.state === "DELETED") existing = undefined;
  const work = mkdtempSync(join(tmpdir(), "qm-microvm-"));
  const archivePath = join(work, "image.zip");
  let operation: ImageOperation | undefined;
  try {
    writeFileSync(archivePath, archive);
    capture(awsBin, [
      "s3api",
      "put-object",
      "--bucket",
      bucket,
      "--key",
      key,
      "--body",
      archivePath,
      "--region",
      aws.region,
      "--output",
      "json",
      "--no-cli-pager",
    ]);
    step(`uploaded ${uri}`);
    const now = options.now ?? Date.now;
    const wait = options.sleep ?? sleep;
    const deadline = now() + (options.timeoutMs ?? 15 * 60_000);
    for (;;) {
      const command = existing ? "update-microvm-image" : "create-microvm-image";
      const identityArgs = existing
        ? ["--image-identifier", existing.imageArn]
        : ["--name", imageName, "--tags", JSON.stringify({ ManagedBy: "qm-cli", Deployment: config.orgId })];
      try {
        operation = JSON.parse(
          capture(awsBin, [
            "lambda-microvms",
            command,
            ...identityArgs,
            "--code-artifact",
            `uri=${uri}`,
            "--base-image-arn",
            baseImageArn,
            "--build-role-arn",
            buildRoleArn,
            "--client-token",
            `${digest}-${randomUUID()}`,
            "--region",
            aws.region,
            "--output",
            "json",
            "--no-cli-pager",
          ]),
        ) as ImageOperation;
        step(`${existing ? "updating" : "creating"} ${imageName}`);
        break;
      } catch (error) {
        if (!/ConflictException|conflict/i.test(error instanceof Error ? error.message : String(error))) throw error;
        if (now() >= deadline) throw new CliError(`timed out waiting to start MicroVM image build ${imageName}`);
        step(`another ${imageName} image operation started; waiting for it before retrying this build`);
        await wait(options.intervalMs ?? 10_000);
        existing = await waitForSettledImage(awsBin, aws.region, imageName, options);
        if (existing && existing.state !== "DELETED") existing = assertImageIdentity(config, awsBin, existing);
        else existing = undefined;
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!operation?.imageArn || !operation.imageVersion) {
    throw new CliError(`AWS did not return the MicroVM image ARN and version for ${imageName}`);
  }
  assertImageIdentity(config, awsBin, { ...operation, name: operation.name || imageName });
  await waitForImageVersion(awsBin, aws.region, operation.imageArn, operation.imageVersion, options);
  return recordImagePin(configPath, operation, operation.imageVersion, executionRoleArn);
}

function listMicrovms(awsBin: string, region: string, imageArn: string): MicrovmSummary[] {
  const parsed = JSON.parse(
    capture(awsBin, [
      "lambda-microvms",
      "list-microvms",
      "--image-identifier",
      imageArn,
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ]),
  ) as { items?: MicrovmSummary[] };
  return parsed.items ?? [];
}

function deleteMicrovmBuildArtifacts(config: QmConfig, awsBin: string): void {
  const aws = config.aws!;
  const bucket = awsObjectStoreBucket(config);
  const prefix = "deployment/microvm-images/";
  const raw = capture(awsBin, [
    "s3api",
    "list-object-versions",
    "--bucket",
    bucket,
    "--prefix",
    prefix,
    "--region",
    aws.region,
    "--output",
    "json",
    "--no-cli-pager",
  ]);
  const parsed = (raw.trim() ? JSON.parse(raw) : {}) as { Versions?: ObjectVersion[]; DeleteMarkers?: ObjectVersion[] };
  const objects = [...(parsed.Versions ?? []), ...(parsed.DeleteMarkers ?? [])]
    .filter((object) => object.Key.startsWith(prefix))
    .map((object) => ({ Key: object.Key, VersionId: object.VersionId }));
  for (let index = 0; index < objects.length; index += 1000) {
    const deleted = JSON.parse(
      capture(awsBin, [
        "s3api",
        "delete-objects",
        "--bucket",
        bucket,
        "--delete",
        JSON.stringify({ Objects: objects.slice(index, index + 1000), Quiet: true }),
        "--region",
        aws.region,
        "--output",
        "json",
        "--no-cli-pager",
      ]),
    ) as { Errors?: Array<{ Key?: string; VersionId?: string; Code?: string }> };
    if (deleted.Errors?.length) {
      throw new CliError(
        `failed to delete MicroVM build artifacts: ${deleted.Errors.map((error) => `${error.Key ?? "unknown"}@${error.VersionId ?? "unknown"} (${error.Code ?? "unknown"})`).join(", ")}`,
      );
    }
  }
  ok(`deleted ${objects.length} MicroVM build artifact version${objects.length === 1 ? "" : "s"}`);
}

export async function deleteAwsMicrovmImage(config: QmConfig, options: InfraWaitOptions = {}): Promise<void> {
  const configured = configuredAws(config, "infra delete-image");
  return withAwsLease(configured.aws, () => deleteAwsMicrovmImageLocked(config, options, configured)).catch(
    guardLambdaMicrovms,
  );
}

async function deleteAwsMicrovmImageLocked(
  config: QmConfig,
  options: InfraWaitOptions,
  configured: ReturnType<typeof configuredAws>,
): Promise<void> {
  const { aws, awsBin, imageName } = configured;
  const expectedArn = `arn:aws:lambda:${aws.region}:${aws.accountId}:microvm-image:${imageName}`;
  let image = findImage(awsBin, aws.region, imageName);
  if (!image || image.state === "DELETED") {
    ok(`MicroVM image ${imageName} is already deleted`);
    deleteMicrovmBuildArtifacts(config, awsBin);
    return;
  }
  assertImageIdentity(config, awsBin, image);
  if (["CREATING", "UPDATING", "DELETING"].includes(image.state)) {
    step(`waiting for ${imageName} to leave state ${image.state}`);
    image = await waitForSettledImage(awsBin, aws.region, imageName, options);
    if (!image || image.state === "DELETED") {
      ok(`MicroVM image ${imageName} is deleted`);
      deleteMicrovmBuildArtifacts(config, awsBin);
      return;
    }
    assertImageIdentity(config, awsBin, image);
  }

  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  let deadline = now() + (options.timeoutMs ?? 15 * 60_000);
  for (;;) {
    const active = listMicrovms(awsBin, aws.region, expectedArn).filter((microvm) => microvm.state !== "TERMINATED");
    for (const microvm of active) {
      if (microvm.state === "TERMINATING") continue;
      capture(awsBin, [
        "lambda-microvms",
        "terminate-microvm",
        "--microvm-identifier",
        microvm.microvmId,
        "--region",
        aws.region,
        "--output",
        "json",
        "--no-cli-pager",
      ]);
      step(`terminating MicroVM ${microvm.microvmId}`);
    }
    if (active.length === 0) break;
    if (now() >= deadline) throw new CliError(`timed out terminating MicroVMs for image ${imageName}`);
    await wait(options.intervalMs ?? 10_000);
  }

  capture(awsBin, [
    "lambda-microvms",
    "delete-microvm-image",
    "--image-identifier",
    expectedArn,
    "--region",
    aws.region,
    "--output",
    "json",
    "--no-cli-pager",
  ]);
  step(`deleting MicroVM image ${imageName}`);
  deadline = now() + (options.timeoutMs ?? 15 * 60_000);
  for (;;) {
    image = findImage(awsBin, aws.region, imageName);
    if (!image || image.state === "DELETED") {
      ok(`deleted MicroVM image ${imageName}`);
      deleteMicrovmBuildArtifacts(config, awsBin);
      return;
    }
    if (image.state === "DELETE_FAILED") throw new CliError(`MicroVM image ${imageName} failed to delete`);
    if (now() >= deadline) throw new CliError(`timed out deleting MicroVM image ${imageName}`);
    await wait(options.intervalMs ?? 10_000);
  }
}
