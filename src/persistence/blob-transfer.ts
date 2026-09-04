import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { Readable } from "node:stream";
import { join } from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  UploadPartCommand,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { swallow, swallowAs } from "../util/errors.ts";
import { asChunks, collectBytes, type ByteSource } from "../util/bytes.ts";
import { bodyToReadable, isNoSuchKey, isNoSuchLifecycleConfiguration, s3Client, type S3Send } from "./s3.ts";

export const MAX_BLOB_BYTES = 1_000_000_000;

export const S3_PART_BYTES = 16 * 1024 * 1024;

interface BlobInfo {
  blobId: string;
  sizeBytes: number;
  sha256: string;
}

interface OpenBlob {
  sizeBytes: number;
  stream: Readable;
}

interface PutOptions {
  maxBytes?: number;
  expectedSha256?: string;
}

type BlobSource = ByteSource;

export interface BlobTransferStore {
  put(source: BlobSource, opts?: PutOptions): Promise<BlobInfo>;
  open(blobId: string): Promise<OpenBlob | null>;
  delete(blobId: string): Promise<void>;
  sweep(maxAgeMs: number): Promise<number>;
  ensureExpiry?(maxAgeDays: number): Promise<boolean>;
}

export class BlobTooLargeError extends Error {
  constructor() {
    super("blob exceeds the size limit");
    this.name = "BlobTooLargeError";
  }
}

export class BlobHashMismatchError extends Error {
  constructor() {
    super("blob content hash mismatch");
    this.name = "BlobHashMismatchError";
  }
}

const BLOB_ID = /^[0-9a-f]{32}$/;

function newBlobId(): string {
  return randomBytes(16).toString("hex");
}

export async function collectBlob(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function createLocalBlobTransferStore(dir: string): BlobTransferStore {
  let ensured: Promise<unknown> | null = null;
  const ensureDir = (): Promise<unknown> => (ensured ??= mkdir(dir, { recursive: true }));

  return {
    async put(source, opts) {
      await ensureDir();
      const blobId = newBlobId();
      const partPath = join(dir, `${blobId}.part`);
      const finalPath = join(dir, blobId);
      const hash = createHash("sha256");
      const out = createWriteStream(partPath);
      let size = 0;
      try {
        for await (const chunk of asChunks(source)) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buf.length;
          if (opts?.maxBytes != null && size > opts.maxBytes) throw new BlobTooLargeError();
          hash.update(buf);
          if (!out.write(buf)) await once(out, "drain");
        }
        await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
      } catch (err) {
        out.destroy();
        await once(out, "close").catch(swallowAs("blob-transfer: write-stream close", undefined));
        await rm(partPath, { force: true }).catch(swallowAs("blob-transfer: partial-file cleanup", undefined));
        throw err;
      }
      const sha256 = hash.digest("hex");
      if (opts?.expectedSha256 && opts.expectedSha256 !== sha256) {
        await rm(partPath, { force: true }).catch(swallowAs("blob-transfer: partial-file cleanup", undefined));
        throw new BlobHashMismatchError();
      }
      await rename(partPath, finalPath);
      return { blobId, sizeBytes: size, sha256 };
    },

    async open(blobId) {
      if (!BLOB_ID.test(blobId)) return null;
      const path = join(dir, blobId);
      let st;
      try {
        st = await stat(path);
      } catch (err) {
        if (err != null && typeof err === "object" && (err as { code?: string }).code === "ENOENT") return null;
        throw err;
      }
      if (!st.isFile()) return null;
      return { sizeBytes: st.size, stream: createReadStream(path) };
    },

    async delete(blobId) {
      if (!BLOB_ID.test(blobId)) return;
      await rm(join(dir, blobId), { force: true }).catch(swallowAs("blob-transfer: delete", undefined));
    },

    async sweep(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return 0;
      }
      for (const name of names) {
        const path = join(dir, name);
        try {
          const st = await stat(path);
          if (st.mtimeMs <= cutoff) {
            await rm(path, { force: true });
            removed++;
          }
        } catch (err) {
          swallow("blob-transfer: sweep entry", err);
        }
      }
      return removed;
    },
  };
}

export interface S3BlobTransferOptions {
  bucket: string;
  region?: string;
  prefix?: string;
  _client?: S3Send;
}

export function createS3BlobTransferStore(options: S3BlobTransferOptions): BlobTransferStore {
  const bucket = options.bucket;
  const prefix = (options.prefix ?? "") + "transfer/";
  const keyFor = (blobId: string): string => prefix + blobId;
  const client = options._client ?? s3Client(options.region);

  return {
    async put(source, opts) {
      const blobId = newBlobId();
      const Key = keyFor(blobId);
      const hash = createHash("sha256");
      let sizeBytes = 0;
      let uploadId: string | undefined;
      const parts: Array<{ ETag: string; PartNumber: number }> = [];
      let pending: Buffer[] = [];
      let pendingBytes = 0;

      const takeExact = (n: number): Buffer => {
        const out = Buffer.allocUnsafe(n);
        let filled = 0;
        while (filled < n) {
          const head = pending[0]!;
          const need = n - filled;
          if (head.length <= need) {
            head.copy(out, filled);
            filled += head.length;
            pending.shift();
          } else {
            head.copy(out, filled, 0, need);
            pending[0] = head.subarray(need);
            filled = n;
          }
        }
        pendingBytes -= n;
        return out;
      };

      const flush = async (last: boolean): Promise<void> => {
        if (last && uploadId && pendingBytes === 0) return;
        const body = last ? Buffer.concat(pending, pendingBytes) : takeExact(S3_PART_BYTES);
        if (last) {
          pending = [];
          pendingBytes = 0;
        }
        if (!uploadId && last) {
          await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: body }));
          return;
        }
        if (!uploadId) {
          const created = (await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key }))) as {
            UploadId?: string;
          };
          if (!created.UploadId) throw new Error("blob-transfer: S3 did not return an UploadId");
          uploadId = created.UploadId;
        }
        const PartNumber = parts.length + 1;
        const done = (await client.send(
          new UploadPartCommand({ Bucket: bucket, Key, UploadId: uploadId, PartNumber, Body: body }),
        )) as { ETag?: string };
        if (!done.ETag) throw new Error("blob-transfer: S3 did not return an ETag for the part");
        parts.push({ ETag: done.ETag, PartNumber });
      };

      try {
        for await (const chunk of asChunks(source)) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          sizeBytes += buf.length;
          if (opts?.maxBytes != null && sizeBytes > opts.maxBytes) throw new BlobTooLargeError();
          hash.update(buf);
          pending.push(buf);
          pendingBytes += buf.length;
          while (pendingBytes > S3_PART_BYTES) await flush(false);
        }
        await flush(true);
        if (uploadId) {
          await client.send(
            new CompleteMultipartUploadCommand({
              Bucket: bucket,
              Key,
              UploadId: uploadId,
              MultipartUpload: { Parts: parts },
            }),
          );
        }
      } catch (err) {
        if (uploadId) {
          await client
            .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId: uploadId }))
            .catch((abortErr: unknown) => {
              console.warn(
                `[blob-transfer] leaked S3 multipart parts for ${Key} (upload ${uploadId}) — abort failed: ${String(abortErr)}`,
              );
            });
        }
        throw err;
      }

      const sha256 = hash.digest("hex");
      if (opts?.expectedSha256 && opts.expectedSha256 !== sha256) {
        await client
          .send(new DeleteObjectCommand({ Bucket: bucket, Key }))
          .catch(swallowAs("blob-transfer: hash-mismatch cleanup", undefined));
        throw new BlobHashMismatchError();
      }
      return { blobId, sizeBytes, sha256 };
    },

    async open(blobId) {
      if (!BLOB_ID.test(blobId)) return null;
      let r: { Body?: unknown; ContentLength?: number };
      try {
        r = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(blobId) }))) as {
          Body?: unknown;
          ContentLength?: number;
        };
      } catch (err) {
        if (isNoSuchKey(err)) return null;
        throw err;
      }
      if (r.Body == null) return null;
      return { sizeBytes: r.ContentLength ?? 0, stream: bodyToReadable(r.Body) };
    },

    async delete(blobId) {
      if (!BLOB_ID.test(blobId)) return;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(blobId) }));
    },

    async sweep(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      let token: string | undefined;
      do {
        const page = (await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }),
        )) as {
          Contents?: Array<{ Key?: string; LastModified?: Date }>;
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        for (const obj of page.Contents ?? []) {
          if (!obj.Key) continue;
          if ((obj.LastModified?.getTime() ?? Infinity) <= cutoff) {
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
            removed++;
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return removed;
    },

    async ensureExpiry(maxAgeDays) {
      const RULE_ID = "qm-transfer-expiry";
      let rules: LifecycleRule[] = [];
      try {
        const cfg = (await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }))) as {
          Rules?: LifecycleRule[];
        };
        rules = cfg.Rules ?? [];
      } catch (err) {
        if (!isNoSuchLifecycleConfiguration(err)) throw err;
      }
      const others = rules.filter((r) => r.ID !== RULE_ID);
      const days = Math.max(1, Math.ceil(maxAgeDays));
      const ours: LifecycleRule = {
        ID: RULE_ID,
        Status: "Enabled",
        Filter: { Prefix: prefix },
        Expiration: { Days: days },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: days },
      };
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: { Rules: [...others, ours] },
        }),
      );
      return true;
    },
  };
}

export function createMemoryBlobTransferStore(): BlobTransferStore {
  const blobs = new Map<string, { data: Buffer; at: number }>();
  return {
    async put(source, opts) {
      const { data, sizeBytes, sha256 } = await collectBytes(source, {
        ...(opts?.maxBytes != null ? { maxBytes: opts.maxBytes } : {}),
        tooLarge: () => new BlobTooLargeError(),
      });
      if (opts?.expectedSha256 && opts.expectedSha256 !== sha256) throw new BlobHashMismatchError();
      const blobId = newBlobId();
      blobs.set(blobId, { data, at: Date.now() });
      return { blobId, sizeBytes, sha256 };
    },
    async open(blobId) {
      const hit = blobs.get(blobId);
      if (!hit) return null;
      return { sizeBytes: hit.data.length, stream: Readable.from(hit.data) };
    },
    async delete(blobId) {
      blobs.delete(blobId);
    },
    async sweep(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      for (const [id, v] of blobs) {
        if (v.at <= cutoff) {
          blobs.delete(id);
          removed++;
        }
      }
      return removed;
    },
  };
}
