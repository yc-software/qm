import { randomUUID } from "node:crypto";
import { mkdir, open as openFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { WebReleases } from "../../plugins/web-ui/server/index.ts";
import { bodyToReadable, isNoSuchKey, s3Client, type S3Send } from "../persistence/s3.ts";
import { LRUCache } from "lru-cache";
import { errMessage, reportFailure } from "../util/errors.ts";
import {
  LIVE_KEY,
  WEB_RELEASE_ROOT,
  parseLivePointer,
  formatLivePointer,
  readWebBundleLayout,
  releaseKey,
  releaseMarkerKey,
  type LivePointer,
  type WebBundleLayout,
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

export function createLocalWebReleaseStore(dir: string): WebReleaseStore {
  const base = resolve(dir);
  const pathOf = (key: string): string => {
    const path = resolve(base, ...key.split("/"));
    if (!path.startsWith(base + sep)) throw new Error(`${key} is outside the web UI release store ${base}`);
    return path;
  };
  return {
    async open(key) {
      try {
        return (await openFile(pathOf(key))).createReadStream();
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
    describe: () => `${dir}${sep}`,
  };
}

export function withLocalAssetCache(store: WebReleaseStore, dir: string): WebReleaseStore {
  const local = createLocalWebReleaseStore(dir);
  const fetched = new LRUCache<string, { found: boolean }>({
    max: 512,
    fetchMethod: async (key) => {
      const remote = await store.open(key);
      if (remote) await local.put(key, await buffer(remote));
      return { found: Boolean(remote) };
    },
  });
  return {
    ...store,
    async open(key) {
      if (!key.startsWith("assets/")) return store.open(key);
      const cached = await local.open(key);
      if (cached) return cached;
      return (await fetched.fetch(key))?.found ? local.open(key) : null;
    },
  };
}

export async function readLivePointer(store: WebReleaseStore): Promise<LivePointer | null> {
  const stream = await store.open(LIVE_KEY);
  if (!stream) return null;
  return parseLivePointer((await buffer(stream)).toString("utf8"), `${store.describe()}${LIVE_KEY}`);
}

async function writeLivePointer(store: WebReleaseStore, pointer: LivePointer): Promise<void> {
  await store.put(LIVE_KEY, Buffer.from(formatLivePointer(pointer)));
}

async function uploadAll(store: WebReleaseStore, dir: string, keyed: Array<[string, string]>): Promise<void> {
  await Readable.from(keyed)
    .map(async ([key, file]: [string, string]) => store.put(key, await readFile(join(dir, file))), {
      concurrency: UPLOAD_WORKERS,
    })
    .toArray();
}

export async function deployBundledRelease(
  store: WebReleaseStore,
  dir: string,
  bundle: WebBundleLayout = readWebBundleLayout(dir),
): Promise<{ id: string; uploaded: boolean; live: string }> {
  const marker = await store.open(releaseMarkerKey(bundle.id));
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
  const log = opts.log ?? ((line: string) => console.error(line));
  let reported = "";
  let failure: unknown;
  const pointer: LRUCache<"live", string> = new LRUCache<"live", string>({
    max: 1,
    ttl: opts.pointerTtlMs ?? 2_000,
    ttlResolution: 0,
    allowStaleOnFetchRejection: true,
    ...(opts.now ? { perf: { now: opts.now } } : {}),
    fetchMethod: async () => {
      try {
        const live = await readLivePointer(store);
        if (!live) throw new Error(`no web UI release is live in ${store.describe()} yet`);
        const bundled = opts.bundled?.();
        reported = "";
        return bundled && live.deployed !== bundled ? bundled : live.release;
      } catch (error) {
        failure = error;
        const stale = pointer.peek("live", { allowStale: true });
        if (stale === undefined) throw error;
        log(`[web] live release pointer unreadable, still serving ${stale}: ${errMessage(error)}`);
        if (errMessage(error) !== reported) {
          reported = errMessage(error);
          reportFailure("web.live_pointer_unreadable", error);
        }
        throw error;
      }
    },
  });
  const files = new LRUCache<string, { body: Buffer | null }, string>({
    max: 512,
    fetchMethod: async (_key, _stale, { context }) => {
      const stream = await store.open(context);
      return { body: stream ? await buffer(stream) : null };
    },
  });

  async function live(): Promise<string> {
    const release = await pointer.fetch("live");
    if (release === undefined) throw failure;
    return release;
  }

  async function releaseFile(name: string): Promise<{ release: string; body: Buffer | null }> {
    const release = await live();
    const key = releaseKey(release, name);
    return { release, body: (await files.fetch(key, { context: key }))?.body ?? null };
  }

  return {
    live,
    async document(name) {
      const { release, body } = await releaseFile(name);
      if (!body) throw new Error(`web UI release ${release} has no ${name} in ${store.describe()}`);
      return body.toString("utf8");
    },
    async file(path, gzip) {
      if (!path.startsWith("assets/")) {
        const plain = (await releaseFile(path)).body;
        if (!plain) return null;
        const packed = gzip ? (await releaseFile(`${path}.gz`)).body : null;
        return packed ? { body: Readable.from(packed), gzip: true } : { body: Readable.from(plain), gzip: false };
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
