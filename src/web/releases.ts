import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { WebReleases } from "../../plugins/web-ui/server/index.ts";
import { bodyToReadable, isNoSuchKey, s3Client, type S3Send } from "../persistence/s3.ts";
import { errMessage } from "../util/errors.ts";
import {
  LIVE_KEY,
  WEB_RELEASE_ROOT,
  parseLivePointer,
  readWebBundleLayout,
  releaseKey,
  type LivePointer,
} from "../../cli/src/web-release.ts";

export interface WebReleaseStore {
  open(key: string): Promise<Readable | null>;
  put(key: string, body: Buffer): Promise<void>;
  describe(): string;
}

const UPLOAD_WORKERS = 8;

export function createS3WebReleaseStore(options: {
  bucket: string;
  prefix?: string;
  region?: string;
  _client?: S3Send;
}): WebReleaseStore {
  const root = `${options.prefix ?? ""}${WEB_RELEASE_ROOT}`;
  const client = options._client ?? s3Client(options.region);
  const where = (key: string): string => `s3://${options.bucket}/${root}${key}`;
  return {
    async open(key) {
      try {
        const r = (await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: root + key }))) as {
          Body?: unknown;
        };
        return bodyToReadable(r.Body);
      } catch (error) {
        if (isNoSuchKey(error)) return null;
        throw new Error(`reading ${where(key)} failed: ${errMessage(error)}`, { cause: error });
      }
    },
    async put(key, body) {
      try {
        await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: root + key, Body: body }));
      } catch (error) {
        throw new Error(`writing ${where(key)} failed: ${errMessage(error)}`, { cause: error });
      }
    },
    describe: () => `s3://${options.bucket}/${root}`,
  };
}

export function createLocalWebReleaseStore(dir: string): WebReleaseStore & { has(key: string): Promise<boolean> } {
  const base = resolve(dir);
  const pathOf = (key: string): string => {
    const path = resolve(base, ...key.split("/"));
    if (!path.startsWith(base + sep)) throw new Error(`${key} is outside the web UI release store ${base}`);
    return path;
  };
  return {
    async open(key) {
      const stream = createReadStream(pathOf(key));
      try {
        await new Promise<void>((resolve, reject) => {
          stream.once("open", () => resolve());
          stream.once("error", reject);
        });
        return stream;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error(`reading ${pathOf(key)} failed: ${errMessage(error)}`, { cause: error });
      }
    },
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      const staging = `${path}.${randomUUID()}.tmp`;
      await writeFile(staging, body);
      await rename(staging, path);
    },
    async has(key) {
      return access(pathOf(key)).then(
        () => true,
        () => false,
      );
    },
    describe: () => `${dir}${sep}`,
  };
}

export function withLocalAssetCache(store: WebReleaseStore, dir: string): WebReleaseStore {
  const local = createLocalWebReleaseStore(dir);
  const fetching = new Map<string, Promise<Buffer | null>>();
  const absent = (key: string): string => `${key}.absent`;
  async function fetchOnce(key: string): Promise<Buffer | null> {
    const remote = await store.open(key);
    if (remote) {
      const body = await readAll(remote);
      await local.put(key, body);
      return body;
    }
    const plain = key.endsWith(".gz") ? key.slice(0, -".gz".length) : undefined;
    if (plain && (await local.has(plain))) await local.put(absent(key), Buffer.alloc(0));
    return null;
  }
  return {
    ...store,
    async open(key) {
      if (!key.startsWith("assets/")) return store.open(key);
      const cached = await local.open(key);
      if (cached) return cached;
      if (await local.has(absent(key))) return null;
      let pending = fetching.get(key);
      if (!pending) {
        pending = fetchOnce(key).finally(() => fetching.delete(key));
        fetching.set(key, pending);
      }
      const body = await pending;
      return body ? Readable.from(body) : null;
    },
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

export async function readLivePointer(store: WebReleaseStore): Promise<LivePointer | null> {
  const stream = await store.open(LIVE_KEY);
  if (!stream) return null;
  return parseLivePointer((await readAll(stream)).toString("utf8"), `${store.describe()}${LIVE_KEY}`);
}

async function writeLivePointer(store: WebReleaseStore, pointer: LivePointer): Promise<void> {
  await store.put(LIVE_KEY, Buffer.from(`${JSON.stringify(pointer)}\n`));
}

async function uploadAll(store: WebReleaseStore, dir: string, keyed: Array<[string, string]>): Promise<void> {
  const queue = [...keyed];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift())
      await store.put(next[0], await readFile(join(dir, next[1])));
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_WORKERS, queue.length) }, worker));
}

export async function deployBundledRelease(
  store: WebReleaseStore,
  dir: string,
): Promise<{ id: string; uploaded: boolean; live: string }> {
  const bundle = readWebBundleLayout(dir);
  const marker = await store.open(releaseKey(bundle.id, "index.html"));
  marker?.destroy();
  if (!marker) {
    await uploadAll(
      store,
      dir,
      bundle.assets.map((file) => [file, file]),
    );
    for (const batch of [bundle.documents.slice(0, -1), bundle.documents.slice(-1)])
      await uploadAll(
        store,
        dir,
        batch.map((file) => [releaseKey(bundle.id, file), file]),
      );
  }
  const pointer = await readLivePointer(store);
  if (pointer?.deployed === bundle.id) return { id: bundle.id, uploaded: !marker, live: pointer.release };
  await writeLivePointer(store, { release: bundle.id, deployed: bundle.id });
  return { id: bundle.id, uploaded: !marker, live: bundle.id };
}

export function createWebReleaseReader(
  store: WebReleaseStore,
  opts: {
    bundled?: () => string | undefined;
    pointerTtlMs?: number;
    now?: () => number;
    log?: (line: string) => void;
  } = {},
): WebReleases & { live(): Promise<string> } {
  const ttl = opts.pointerTtlMs ?? 2_000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.error(line));
  let current: { release: string; readAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  let files = new Map<string, Promise<Buffer | null>>();
  let filesFor = "";

  async function refresh(): Promise<string> {
    try {
      const pointer = await readLivePointer(store);
      if (!pointer) throw new Error(`no web UI release is live in ${store.describe()} yet`);
      const bundled = opts.bundled?.();
      const release = bundled && pointer.deployed !== bundled ? bundled : pointer.release;
      current = { release, readAt: now() };
    } catch (error) {
      if (!current) throw error;
      log(`[web] live release pointer unreadable, still serving ${current.release}: ${errMessage(error)}`);
      current = { release: current.release, readAt: now() };
    }
    return current.release;
  }

  async function live(): Promise<string> {
    if (current && now() - current.readAt < ttl) return current.release;
    inflight ??= refresh().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  async function releaseFile(name: string): Promise<Buffer | null> {
    const release = await live();
    if (filesFor !== release) {
      files = new Map();
      filesFor = release;
    }
    const known = files.get(name);
    if (known) return known;
    const loading = store.open(releaseKey(release, name)).then((stream) => (stream ? readAll(stream) : null));
    files.set(name, loading);
    loading.then(
      (body) => body ?? files.delete(name),
      () => files.delete(name),
    );
    return loading;
  }

  return {
    live,
    async document(name) {
      const body = await releaseFile(name);
      if (!body) throw new Error(`web UI release ${current?.release} has no ${name} in ${store.describe()}`);
      return body.toString("utf8");
    },
    async file(path, gzip) {
      if (!path.startsWith("assets/")) {
        const packed = gzip ? await releaseFile(`${path}.gz`) : null;
        if (packed) return { body: Readable.from(packed), gzip: true };
        const plain = await releaseFile(path);
        return plain ? { body: Readable.from(plain), gzip: false } : null;
      }
      if (gzip) {
        const packed = await store.open(`${path}.gz`);
        if (packed) return { body: packed, gzip: true };
      }
      const plain = await store.open(path);
      return plain ? { body: plain, gzip: false } : null;
    },
  };
}
