import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AbortMultipartUploadCommand,
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
import { createPgPool, ownerDatabaseUrl, PG_MIGRATIONS_TABLE } from "../persistence/pg-pool.ts";
import { swallowAs } from "../util/errors.ts";
import { FILES_AREA } from "../files/durable-byte-store.ts";
import { HOME_SNAPSHOT_AREAS } from "../sandbox/home-snapshot.ts";
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
  add(clientFor(config.awsDeploy.region), config.awsDeploy.dataBucket, deployDataArea(config.awsDeploy.dataPrefix));
  const dirs = ["transfer", FILES_AREA, "session-shares", "workspaces"].map((area) => join(config.dataDir, area));
  return { objects, dirs: [...dirs, config.deployGitDir] };
}

function soleTenant(tenants: ReadonlySet<string>, where: string): string {
  if (tenants.size !== 1)
    throw new Error(`${where} predates tenant storage and this database has ${tenants.size} tenants`);
  return [...tenants][0]!;
}

async function* pages(area: ObjectArea, Prefix: string, Delimiter?: string) {
  let token: string | undefined;
  do {
    const page = (await area.client.send(
      new ListObjectsV2Command({
        Bucket: area.bucket,
        Prefix,
        ...(Delimiter ? { Delimiter } : {}),
        ...(token ? { ContinuationToken: token } : {}),
      }),
    )) as {
      Contents?: Array<Partial<Listed>>;
      CommonPrefixes?: Array<{ Prefix?: string }>;
      IsTruncated?: boolean;
      NextContinuationToken?: string;
    };
    yield {
      objects: (page.Contents ?? []).flatMap((o) =>
        o.Key ? [{ Key: o.Key, Size: o.Size ?? 0, LastModified: o.LastModified ?? new Date(0) }] : [],
      ),
      folders: (page.CommonPrefixes ?? []).flatMap((p) => (p.Prefix ? [p.Prefix] : [])),
    };
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

async function* legacyObjects(area: ObjectArea, tenants: ReadonlySet<string>): AsyncGenerator<Listed> {
  if (area.from !== area.to) {
    for await (const page of pages(area, area.from)) yield* page.objects;
    return;
  }
  const folders: string[] = [];
  for await (const page of pages(area, area.from, "/")) {
    yield* page.objects;
    folders.push(...page.folders.filter((folder) => !tenants.has(folder.slice(area.from.length, -1))));
  }
  for (const folder of folders) for await (const page of pages(area, folder)) yield* page.objects;
}

async function copyObject(area: ObjectArea, source: Listed, Key: string): Promise<void> {
  const CopySource = `${area.bucket}/${encodeURIComponent(source.Key).replace(/%2F/g, "/")}`;
  if (source.Size <= SINGLE_COPY_MAX) {
    await area.client.send(new CopyObjectCommand({ Bucket: area.bucket, Key, CopySource }));
    return;
  }
  const started = (await area.client.send(new CreateMultipartUploadCommand({ Bucket: area.bucket, Key }))) as {
    UploadId?: string;
  };
  if (!started.UploadId) throw new Error(`S3 did not start a copy of ${source.Key}`);
  const UploadId = started.UploadId;
  try {
    const Parts: Array<{ ETag: string; PartNumber: number }> = [];
    for (let start = 0; start < source.Size; start += COPY_PART_BYTES) {
      const end = Math.min(source.Size, start + COPY_PART_BYTES) - 1;
      const PartNumber = Parts.length + 1;
      const part = (await area.client.send(
        new UploadPartCopyCommand({
          Bucket: area.bucket,
          Key,
          UploadId,
          PartNumber,
          CopySource,
          CopySourceRange: `bytes=${start}-${end}`,
        }),
      )) as { CopyPartResult?: { ETag?: string } };
      if (!part.CopyPartResult?.ETag) throw new Error(`S3 did not copy part ${PartNumber} of ${source.Key}`);
      Parts.push({ ETag: part.CopyPartResult.ETag, PartNumber });
    }
    await area.client.send(
      new CompleteMultipartUploadCommand({ Bucket: area.bucket, Key, UploadId, MultipartUpload: { Parts } }),
    );
  } catch (error) {
    await area.client
      .send(new AbortMultipartUploadCommand({ Bucket: area.bucket, Key, UploadId }))
      .catch(swallowAs("tenant storage: abort copy", undefined));
    throw error;
  }
}

async function exists(area: ObjectArea, Key: string): Promise<boolean> {
  try {
    await area.client.send(new HeadObjectCommand({ Bucket: area.bucket, Key }));
    return true;
  } catch (error) {
    if (isNoSuchKey(error)) return false;
    throw error;
  }
}

export async function migrateObjects(area: ObjectArea, tenants: ReadonlySet<string>): Promise<number> {
  let moved = 0;
  for await (const source of legacyObjects(area, tenants)) {
    const rest = source.Key.slice(area.from.length);
    const Key = `${area.to}${soleTenant(tenants, `s3://${area.bucket}/${source.Key}`)}/${area.under ?? ""}${rest}`;
    if (!(await exists(area, Key))) await copyObject(area, source, Key);
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
  if ((await lstat(from)).isDirectory() && target.isDirectory())
    for (const name of await readdir(from)) await mergeInto(join(from, name), join(to, name));
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

async function migrateTenantStorage(
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

const STORAGE_MIGRATION = "tenants/storage-layout";

export async function migrateTenantStorageOnce(config: Config): Promise<void> {
  if (!config.databaseUrl) return;
  const db = createPgPool(ownerDatabaseUrl(config.databaseUrl));
  try {
    const client = await (await db.pool()).connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [STORAGE_MIGRATION]);
      const done = await client.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [STORAGE_MIGRATION]);
      if (done.rowCount) return;
      const tenants = new Set((await client.query("SELECT id::text AS id FROM tenants")).rows.map((r) => String(r.id)));
      const moved = await migrateTenantStorage(config, tenants);
      await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $1)`, [STORAGE_MIGRATION]);
      console.log(`[qm:migrate] tenant storage layout applied (${moved} moved)`);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [STORAGE_MIGRATION])
        .catch(swallowAs("tenant storage: unlock", undefined));
      client.release();
    }
  } finally {
    await db.close();
  }
}
