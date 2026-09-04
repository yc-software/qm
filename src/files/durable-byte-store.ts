import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { Readable } from "node:stream";
import { join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { swallowAs } from "../util/errors.ts";
import { collectBytes, type ByteSource } from "../util/bytes.ts";
import { bodyToReadable, isNoSuchKey, s3Client, type S3Send } from "../persistence/s3.ts";

export type { ByteSource } from "../util/bytes.ts";

interface PutBytesResult {
  blobKey: string;
  sizeBytes: number;
  sha256: string;
}

interface OpenBytes {
  sizeBytes: number;
  stream: Readable;
}

interface PutBytesOptions {
  maxBytes?: number;
}

export interface DurableByteStore {
  put(source: ByteSource, opts?: PutBytesOptions): Promise<PutBytesResult>;
  open(blobKey: string): Promise<OpenBytes | null>;
  delete(blobKey: string): Promise<void>;
}

export class ByteSourceTooLargeError extends Error {
  constructor() {
    super("file exceeds the size limit");
    this.name = "ByteSourceTooLargeError";
  }
}

const BLOB_KEY = /^files\/[0-9a-f]{64}$/;
const keyFor = (sha256: string): string => `files/${sha256}`;

function collect(source: ByteSource, maxBytes?: number): Promise<{ data: Buffer; sha256: string }> {
  return collectBytes(source, {
    ...(maxBytes != null ? { maxBytes } : {}),
    tooLarge: () => new ByteSourceTooLargeError(),
  });
}

export function createMemoryDurableByteStore(): DurableByteStore {
  const blobs = new Map<string, Buffer>();
  return {
    async put(source, opts) {
      const { data, sha256 } = await collect(source, opts?.maxBytes);
      const blobKey = keyFor(sha256);
      if (!blobs.has(blobKey)) blobs.set(blobKey, data);
      return { blobKey, sizeBytes: data.length, sha256 };
    },
    async open(blobKey) {
      const hit = blobs.get(blobKey);
      if (!hit) return null;
      return { sizeBytes: hit.length, stream: Readable.from(hit) };
    },
    async delete(blobKey) {
      blobs.delete(blobKey);
    },
  };
}

export function createLocalDurableByteStore(dir: string): DurableByteStore {
  const base = join(dir, "files");
  let ensured: Promise<unknown> | null = null;
  const ensureDir = (): Promise<unknown> => (ensured ??= mkdir(base, { recursive: true }));

  return {
    async put(source, opts) {
      const { data, sha256 } = await collect(source, opts?.maxBytes);
      const blobKey = keyFor(sha256);
      await ensureDir();
      const finalPath = join(base, sha256);
      try {
        if ((await stat(finalPath)).isFile()) return { blobKey, sizeBytes: data.length, sha256 };
      } catch (error) {
        void error;
      }
      const partPath = join(base, `${sha256}.${randomUUID()}.part`);
      const out = createWriteStream(partPath);
      try {
        if (!out.write(data)) await once(out, "drain");
        await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
      } catch (err) {
        out.destroy();
        await once(out, "close").catch(swallowAs("files: write-stream close", undefined));
        await rm(partPath, { force: true }).catch(swallowAs("files: partial-file cleanup", undefined));
        throw err;
      }
      try {
        await rename(partPath, finalPath);
      } catch (err) {
        await rm(partPath, { force: true }).catch(swallowAs("files: partial-file cleanup", undefined));
        throw err;
      }
      return { blobKey, sizeBytes: data.length, sha256 };
    },

    async open(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return null;
      const path = join(base, blobKey.slice("files/".length));
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

    async delete(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return;
      await rm(join(base, blobKey.slice("files/".length)), { force: true }).catch(
        swallowAs("files: delete", undefined),
      );
    },
  };
}

export interface S3DurableByteOptions {
  bucket: string;
  region?: string;
  prefix?: string;
  _client?: S3Send;
}

export function createS3DurableByteStore(options: S3DurableByteOptions): DurableByteStore {
  const bucket = options.bucket;
  const prefix = options.prefix ?? "";
  const s3Key = (blobKey: string): string => prefix + blobKey;
  const client = options._client ?? s3Client(options.region);

  return {
    async put(source, opts) {
      const { data, sha256 } = await collect(source, opts?.maxBytes);
      const blobKey = keyFor(sha256);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: s3Key(blobKey), Body: data }));
      return { blobKey, sizeBytes: data.length, sha256 };
    },

    async open(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return null;
      let r: { Body?: unknown; ContentLength?: number };
      try {
        r = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key(blobKey) }))) as {
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

    async delete(blobKey) {
      if (!BLOB_KEY.test(blobKey)) return;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key(blobKey) }));
    },
  };
}
