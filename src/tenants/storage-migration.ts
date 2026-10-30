import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import type { Config } from "../config.ts";
import { isNoSuchKey, s3Client, type S3Send } from "../persistence/s3.ts";
import { FILES_AREA } from "../files/durable-byte-store.ts";
import { HOME_SNAPSHOT_AREAS } from "../sandbox/home-snapshot.ts";
import { awsHomeArea } from "../sandbox/aws-sandbox.ts";
import { deployDataArea } from "../deploy/aws-deploy-provider.ts";

const COPY_PART_BYTES = 1024 ** 3;
const SINGLE_COPY_MAX = 5 * 1024 ** 3;

export interface ObjectArea {
  client: S3Send;
  bucket: string;
  from: string;
  to: string;
  under?: string;
}

interface Listed {
  Key: string;
  Size: number;
  LastModified: Date;
}

function storageAreas(config: Config, clientFor: (region?: string, endpoint?: string) => S3Send) {
  const objects: ObjectArea[] = [];
  const add = (client: S3Send, bucket: string | undefined, from: string, to = from, under?: string): void => {
    const slash = (path: string): string => `${path.replace(/\/+$/, "")}/`;
    if (bucket) objects.push({ client, bucket, from: slash(from), to: slash(to), ...(under ? { under } : {}) });
  };
  const p = config.s3Prefix ?? "";
  const main = clientFor(config.s3Region, config.s3Endpoint);
  add(main, config.s3Bucket, `${p}transfer`);
  add(main, config.s3Bucket, `${p}files`, `${p}${FILES_AREA}`, "files/");
  add(main, config.s3Bucket, `${p}session-shares`);
  add(main, config.s3Bucket, `${p}deploy-git`);
  add(main, config.s3Bucket, `${p}app-data`);
  const snapshots = clientFor();
  add(snapshots, config.spritesSandbox.snapshotS3Bucket, HOME_SNAPSHOT_AREAS.sprites);
  add(snapshots, config.smolmachinesSandbox.snapshotS3Bucket, HOME_SNAPSHOT_AREAS.smolmachines);
  add(snapshots, config.e2bSandbox.snapshotS3Bucket, HOME_SNAPSHOT_AREAS.e2b);
  add(snapshots, config.managedAgentsSandbox.snapshotS3Bucket, HOME_SNAPSHOT_AREAS.managedAgents);
  add(snapshots, config.modalSandbox.snapshotS3Bucket, HOME_SNAPSHOT_AREAS.modal);
  const aws = clientFor(config.awsSandbox.region);
  add(aws, config.awsSandbox.s3Bucket, awsHomeArea(config.awsSandbox.s3Prefix));
  add(aws, config.awsDeploy.dataBucket ?? config.awsSandbox.s3Bucket, deployDataArea(config.awsDeploy.dataPrefix));
  const dirs = ["transfer", FILES_AREA, "session-shares", "workspaces"].map((area) => join(config.dataDir, area));
  return { objects, dirs: [...dirs, config.deployGitDir] };
}

function soleTenant(tenants: ReadonlySet<string>, where: string): string {
  if (tenants.size !== 1)
    throw new Error(`${where} predates tenant storage and this database has ${tenants.size} tenants`);
  return [...tenants][0]!;
}

async function* listed(area: ObjectArea): AsyncGenerator<Listed> {
  let token: string | undefined;
  do {
    const page = (await area.client.send(
      new ListObjectsV2Command({
        Bucket: area.bucket,
        Prefix: area.from,
        ...(token ? { ContinuationToken: token } : {}),
      }),
    )) as { Contents?: Array<Partial<Listed>>; IsTruncated?: boolean; NextContinuationToken?: string };
    for (const o of page.Contents ?? [])
      if (o.Key) yield { Key: o.Key, Size: o.Size ?? 0, LastModified: o.LastModified ?? new Date(0) };
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

async function copyObject(area: ObjectArea, source: Listed, Key: string): Promise<void> {
  const CopySource = encodeURIComponent(`${area.bucket}/${source.Key}`);
  if (source.Size <= SINGLE_COPY_MAX) {
    await area.client.send(new CopyObjectCommand({ Bucket: area.bucket, Key, CopySource }));
    return;
  }
  const started = (await area.client.send(new CreateMultipartUploadCommand({ Bucket: area.bucket, Key }))) as {
    UploadId?: string;
  };
  if (!started.UploadId) throw new Error(`S3 did not start a copy of ${source.Key}`);
  const Parts: Array<{ ETag: string; PartNumber: number }> = [];
  for (let start = 0; start < source.Size; start += COPY_PART_BYTES) {
    const end = Math.min(source.Size, start + COPY_PART_BYTES) - 1;
    const PartNumber = Parts.length + 1;
    const part = (await area.client.send(
      new UploadPartCopyCommand({
        Bucket: area.bucket,
        Key,
        UploadId: started.UploadId,
        PartNumber,
        CopySource,
        CopySourceRange: `bytes=${start}-${end}`,
      }),
    )) as { CopyPartResult?: { ETag?: string } };
    if (!part.CopyPartResult?.ETag) throw new Error(`S3 did not copy part ${PartNumber} of ${source.Key}`);
    Parts.push({ ETag: part.CopyPartResult.ETag, PartNumber });
  }
  await area.client.send(
    new CompleteMultipartUploadCommand({
      Bucket: area.bucket,
      Key,
      UploadId: started.UploadId,
      MultipartUpload: { Parts },
    }),
  );
}

async function newer(area: ObjectArea, Key: string, than: Date): Promise<boolean> {
  try {
    const head = (await area.client.send(new HeadObjectCommand({ Bucket: area.bucket, Key }))) as {
      LastModified?: Date;
    };
    return (head.LastModified?.getTime() ?? 0) >= than.getTime();
  } catch (error) {
    if (isNoSuchKey(error)) return false;
    throw error;
  }
}

export async function migrateObjects(area: ObjectArea, tenants: ReadonlySet<string>): Promise<number> {
  let moved = 0;
  for await (const source of listed(area)) {
    const rest = source.Key.slice(area.from.length);
    if (area.from === area.to && tenants.has(rest.split("/")[0]!)) continue;
    const Key = `${area.to}${soleTenant(tenants, `s3://${area.bucket}/${source.Key}`)}/${area.under ?? ""}${rest}`;
    if (!(await newer(area, Key, source.LastModified))) await copyObject(area, source, Key);
    await area.client.send(new DeleteObjectCommand({ Bucket: area.bucket, Key: source.Key }));
    moved++;
  }
  return moved;
}

async function mergeInto(from: string, to: string): Promise<void> {
  const target = await lstat(to).catch(() => null);
  if (!target) {
    await rename(from, to);
    return;
  }
  const source = await lstat(from);
  if (source.isDirectory() && target.isDirectory()) {
    for (const name of await readdir(from)) await mergeInto(join(from, name), join(to, name));
    await rm(from, { recursive: true, force: true });
    return;
  }
  if (source.mtimeMs > target.mtimeMs) {
    await rm(to, { recursive: true, force: true });
    await rename(from, to);
    return;
  }
  await rm(from, { recursive: true, force: true });
}

export async function migrateDir(root: string, tenants: ReadonlySet<string>): Promise<number> {
  let moved = 0;
  for (const name of await readdir(root).catch(() => [])) {
    if (tenants.has(name)) continue;
    const tenant = soleTenant(tenants, join(root, name));
    await mkdir(join(root, tenant), { recursive: true });
    await mergeInto(join(root, name), join(root, tenant, name));
    moved++;
  }
  return moved;
}

export async function migrateTenantStorage(
  config: Config,
  tenants: ReadonlySet<string>,
  clientFor: (region?: string, endpoint?: string) => S3Send = (region, endpoint) =>
    s3Client(region, endpoint ? { endpoint } : {}),
): Promise<number> {
  const areas = storageAreas(config, clientFor);
  let moved = 0;
  for (const dir of areas.dirs) moved += await migrateDir(dir, tenants);
  for (const area of areas.objects) moved += await migrateObjects(area, tenants);
  return moved;
}
