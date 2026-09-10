import { basename } from "node:path/posix";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { shq } from "../util/shell.ts";
import { swallowAs } from "../util/errors.ts";
import { sleep, withTimeout } from "../util/async.ts";
import { bodyToReadable, isNoSuchKey, s3Client, type S3Send } from "../persistence/s3.ts";
import { displacedPruneGlobs } from "../credentials/resident-paths.ts";
import type { TeardownOptions } from "./sandbox.ts";

const SNAPSHOT_PART_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;
export const HOME_SNAPSHOT_PRUNE = [
  "./.cred-state*",
  ...displacedPruneGlobs(),
  "*/.cache",
  "./.npm/_cacache",
  "./.pnpm-store",
  "./.cargo/registry",
  "./go/pkg/mod",
  "*/node_modules",
  "*/.venv",
  "*/__pycache__",
];

export interface SnapshotBookkeeping {
  lastSnapshotMs?: number;
  homeDirty?: boolean;
}

export function snapshotDue(
  stored: SnapshotBookkeeping | null | undefined,
  tdOpts: TeardownOptions | undefined,
  intervalMs: number,
  now = Date.now(),
): boolean {
  const throttled = !!stored?.lastSnapshotMs && now - stored.lastSnapshotMs <= intervalMs;
  if (throttled) return false;
  return !tdOpts?.homeUnchanged || stored?.homeDirty !== false;
}

export interface SnapshotUpload {
  addPart(bytes: Uint8Array): Promise<void>;
  complete(): Promise<void>;
  abort(): Promise<void>;
}

interface StoredSnapshot {
  size: number;
  parts: AsyncIterable<Uint8Array>;
}

export interface HomeSnapshotStore {
  open(scope: string): Promise<StoredSnapshot | null>;
  put(scope: string, data: Uint8Array): Promise<void>;
  createUpload(scope: string): Promise<SnapshotUpload>;
  adoptFromS3?(scope: string, ref: { bucket: string; key: string }): Promise<void>;
}

export class SnapshotTooLargeError extends Error {
  constructor(label: string, size: number, cap: number) {
    super(`${label} snapshot skipped: home tar is ${size} bytes, cap is ${cap}`);
    this.name = "SnapshotTooLargeError";
  }
}

async function* singlePart(data: Uint8Array): AsyncGenerator<Uint8Array> {
  yield data;
}

export function createMemorySnapshotStore(): HomeSnapshotStore {
  const map = new Map<string, Uint8Array>();
  return {
    open: async (scope) => {
      const data = map.get(scope);
      return data ? { size: data.length, parts: singlePart(data) } : null;
    },
    put: async (scope, data) => {
      map.set(scope, data);
    },
    createUpload: async (scope) => {
      const parts: Uint8Array[] = [];
      return {
        addPart: async (bytes) => {
          parts.push(bytes);
        },
        complete: async () => {
          map.set(scope, Buffer.concat(parts));
        },
        abort: async () => {},
      };
    },
  };
}

export interface S3SnapshotStoreOptions {
  bucket: string;
  prefix: string;
  region?: string;
  s3?: S3Send;
  keyFor?: (scope: string) => string;
}

export function createS3SnapshotStore(opts: S3SnapshotStoreOptions): HomeSnapshotStore {
  const s3 = opts.s3 ?? s3Client(opts.region);
  const keyFor = opts.keyFor ?? ((scope: string): string => `${opts.prefix}/${encodeURIComponent(scope)}.tar`);
  const Bucket = opts.bucket;
  return {
    async open(scope): Promise<StoredSnapshot | null> {
      let got: { Body?: unknown; ContentLength?: number };
      try {
        got = (await s3.send(new GetObjectCommand({ Bucket, Key: keyFor(scope) }))) as typeof got;
      } catch (e) {
        if (isNoSuchKey(e)) return null;
        throw e;
      }
      if (!got.Body) return null;
      return { size: got.ContentLength ?? -1, parts: bodyToReadable(got.Body) };
    },
    async put(scope, data): Promise<void> {
      await s3.send(new PutObjectCommand({ Bucket, Key: keyFor(scope), Body: data }));
    },
    async createUpload(scope): Promise<SnapshotUpload> {
      const Key = keyFor(scope);
      const started = (await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }))) as { UploadId?: string };
      const UploadId = started.UploadId!;
      const parts: Array<{ ETag: string; PartNumber: number }> = [];
      const abort = async (): Promise<void> => {
        await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })).catch(() => {});
      };
      return {
        async addPart(bytes) {
          const PartNumber = parts.length + 1;
          const uploaded = (await s3.send(
            new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body: bytes, ContentLength: bytes.length }),
          )) as { ETag?: string };
          parts.push({ ETag: uploaded.ETag!, PartNumber });
        },
        async complete() {
          if (!parts.length) {
            await abort();
            await s3.send(new PutObjectCommand({ Bucket, Key, Body: new Uint8Array(0) }));
            return;
          }
          await s3.send(
            new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: parts } }),
          );
        },
        abort,
      };
    },
    async adoptFromS3(scope, ref): Promise<void> {
      const head = (await s3.send(new HeadObjectCommand({ Bucket: ref.bucket, Key: ref.key }))) as {
        ContentLength?: number;
      };
      const size = head.ContentLength ?? 0;
      const Key = keyFor(scope);
      const source = `/${ref.bucket}/${encodeURIComponent(ref.key)}`;
      if (size <= SINGLE_COPY_MAX_BYTES) {
        await s3.send(new CopyObjectCommand({ Bucket, Key, CopySource: source }));
        return;
      }
      const started = (await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }))) as { UploadId?: string };
      const uploadId = started.UploadId!;
      try {
        const parts: Array<{ ETag: string; PartNumber: number }> = [];
        for (let offset = 0, part = 1; offset < size; offset += COPY_PART_BYTES, part++) {
          const end = Math.min(offset + COPY_PART_BYTES, size) - 1;
          const copied = (await s3.send(
            new UploadPartCopyCommand({
              Bucket,
              Key,
              UploadId: uploadId,
              PartNumber: part,
              CopySource: source,
              CopySourceRange: `bytes=${offset}-${end}`,
            }),
          )) as { CopyPartResult?: { ETag?: string } };
          parts.push({ ETag: copied.CopyPartResult!.ETag!, PartNumber: part });
        }
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket,
            Key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        );
      } catch (e) {
        await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId: uploadId })).catch(() => {});
        throw e;
      }
    },
  };
}

const SINGLE_COPY_MAX_BYTES = 4_500_000_000;
const COPY_PART_BYTES = 1_000_000_000;

export interface HomeSnapshotSessionIo<S> {
  runCommand(
    session: S,
    script: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFileBytes(session: S, absPath: string): Promise<Uint8Array | null>;
  writeFileBytes(session: S, absPath: string, data: Uint8Array): Promise<void>;
}

export interface HomeSnapshotOpsOptions<S> {
  label: string;
  homeDir: string;
  homeTarPath: string;
  prunePaths: string[];
  store: HomeSnapshotStore;
  io: HomeSnapshotSessionIo<S>;
  partBytes?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface HomeSnapshotOps<S> {
  snapshotHome(scope: string, session: S): Promise<void>;
  hydrateHome(scope: string, session: S): Promise<boolean>;
}

async function* coalesce(parts: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array[] = [];
  let pendingLen = 0;
  for await (const chunk of parts) {
    pending.push(chunk);
    pendingLen += chunk.length;
    while (pendingLen >= size) {
      const joined = Buffer.concat(pending, pendingLen);
      yield joined.subarray(0, size);
      const rest = joined.subarray(size);
      pending = rest.length ? [rest] : [];
      pendingLen = rest.length;
    }
  }
  if (pendingLen) yield Buffer.concat(pending, pendingLen);
}

export function createHomeSnapshotOps<S>(opts: HomeSnapshotOpsOptions<S>): HomeSnapshotOps<S> {
  const { label, homeDir, homeTarPath, store, io } = opts;
  const partBytes = opts.partBytes ?? SNAPSHOT_PART_BYTES;
  const maxBytes = opts.maxBytes ?? SNAPSHOT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
  const scratchInHome = homeTarPath.startsWith(`${homeDir}/`);
  const prunePaths = scratchInHome ? [...opts.prunePaths, `./${basename(homeTarPath)}*`] : opts.prunePaths;
  const partPath = (i: number): string => `${homeTarPath}.${i}.part`;
  const listPath = `${homeTarPath}.list`;

  const startClock = (): (() => number) => {
    const deadline = Date.now() + timeoutMs;
    return () => {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${label} snapshot exceeded ${timeoutMs}ms`);
      return left;
    };
  };

  const run = async (
    session: S,
    script: string,
    cap: number,
    left: () => number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
    io.runCommand(session, script, Math.min(cap, left()));

  const removeScratch = (session: S, what: string): Promise<void> =>
    io
      .runCommand(session, `rm -f ${shq(homeTarPath)} ${shq(homeTarPath)}.*`, 30_000)
      .then(() => undefined)
      .catch(swallowAs(`${label}-sandbox: ${what}`, undefined));

  async function tarSize(session: S, left: () => number): Promise<number> {
    const stat = await run(session, `wc -c < ${shq(homeTarPath)}`, 30_000, left);
    const size = Number(stat.stdout.trim());
    if (stat.exitCode !== 0 || !Number.isSafeInteger(size) || size <= 0)
      throw new Error(`${label} snapshot read-back empty`);
    return size;
  }

  async function readPart(session: S, i: number, expected: number, left: () => number): Promise<Uint8Array> {
    const part = partPath(i);
    let detail = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const cut = await run(
        session,
        `dd if=${shq(homeTarPath)} of=${shq(part)} bs=${partBytes} skip=${i} count=1`,
        180_000,
        left,
      );
      if (cut.exitCode !== 0) throw new Error(`${label} snapshot part ${i}: dd failed: ${cut.stderr.slice(0, 200)}`);
      const bytes = await withTimeout(
        () => io.readFileBytes(session, part),
        left(),
        `${label} snapshot part ${i} read`,
      );
      if (bytes && bytes.length === expected) return bytes;
      detail = `got ${bytes?.length ?? 0} bytes, expected ${expected}`;
    }
    throw new Error(`${label} snapshot part ${i}: ${detail}`);
  }

  async function writePart(session: S, i: number, bytes: Uint8Array, left: () => number): Promise<void> {
    const part = partPath(i);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await withTimeout(() => io.writeFileBytes(session, part, bytes), left(), `${label} hydrate part ${i} write`);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await sleep(500 * (attempt + 1));
      }
    }
    if (lastErr !== undefined) throw lastErr;
    const appended = await run(session, `cat ${shq(part)} >> ${shq(homeTarPath)} && rm -f ${shq(part)}`, 180_000, left);
    if (appended.exitCode !== 0)
      throw new Error(`${label} hydrate part ${i}: append failed: ${appended.stderr.slice(0, 200)}`);
  }

  return {
    async snapshotHome(scope, session): Promise<void> {
      const left = startClock();
      const prune = prunePaths.length
        ? `\\( ${prunePaths.map((p) => `-path ${shq(p)}`).join(" -o ")} \\) -prune -o `
        : "";
      const script = `cd ${shq(homeDir)} 2>/dev/null || exit 0; find . ${prune}\\( ! -type d -o -exec test -r {} \\; \\) -print0 > ${shq(listPath)} 2>/dev/null; tar --no-recursion --null -T ${shq(listPath)} -cf ${shq(homeTarPath)}; rc=$?; rm -f ${shq(listPath)}; exit $rc`;
      try {
        const made = await run(session, script, 180_000, left);
        if (made.exitCode !== 0) throw new Error(`${label} snapshot tar failed: ${made.stderr.slice(0, 200)}`);
        const size = await tarSize(session, left);
        if (size > maxBytes) throw new SnapshotTooLargeError(label, size, maxBytes);
        const upload = await withTimeout(() => store.createUpload(scope), left(), `${label} snapshot upload start`);
        try {
          for (let i = 0, offset = 0; offset < size; i++, offset += partBytes) {
            const bytes = await readPart(session, i, Math.min(partBytes, size - offset), left);
            await withTimeout(() => upload.addPart(bytes), left(), `${label} snapshot part ${i} upload`);
          }
          await withTimeout(() => upload.complete(), left(), `${label} snapshot upload completion`);
        } catch (e) {
          await upload.abort().catch(swallowAs(`${label}-sandbox: snapshot upload abort`, undefined));
          throw e;
        }
      } finally {
        await removeScratch(session, "snapshot cleanup");
      }
    },

    async hydrateHome(scope, session): Promise<boolean> {
      const left = startClock();
      const stored = await withTimeout(() => store.open(scope), left(), `${label} hydrate open`);
      if (!stored) return false;
      if (!Number.isSafeInteger(stored.size) || stored.size <= 0)
        throw new Error(`${label} hydrate: invalid snapshot size ${stored.size}`);
      try {
        const started = await run(session, `mkdir -p ${shq(homeDir)} && : > ${shq(homeTarPath)}`, 30_000, left);
        if (started.exitCode !== 0)
          throw new Error(`${label} hydrate: truncate failed: ${started.stderr.slice(0, 200)}`);
        let total = 0;
        let i = 0;
        for await (const piece of coalesce(stored.parts, partBytes)) {
          total += piece.length;
          if (total > stored.size)
            throw new Error(`${label} hydrate: received ${total} bytes, expected ${stored.size}`);
          await writePart(session, i++, piece, left);
        }
        if (total !== stored.size)
          throw new Error(`${label} hydrate: received ${total} bytes, expected ${stored.size}`);
        const written = await tarSize(session, left);
        if (written !== stored.size)
          throw new Error(`${label} hydrate: wrote ${written} bytes, expected ${stored.size}`);
        const validated = await run(session, `tar -tf ${shq(homeTarPath)} > /dev/null`, 180_000, left);
        if (validated.exitCode !== 0)
          throw new Error(`${label} hydrate archive invalid: ${validated.stderr.slice(0, 200)}`);
        const r = await run(
          session,
          `cd ${shq(homeDir)} && tar -xf ${shq(homeTarPath)}; rc=$?; rm -f ${shq(homeTarPath)}; exit $rc`,
          180_000,
          left,
        );
        if (r.exitCode !== 0) throw new Error(`${label} hydrate extract failed: ${r.stderr.slice(0, 200)}`);
        return true;
      } finally {
        await removeScratch(session, "hydrate cleanup");
      }
    },
  };
}
