import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { bodyToReadable, isNoSuchKey, s3Client, type S3Send } from "../persistence/s3.ts";
import { errMessage } from "../util/errors.ts";

export interface WebReleaseStore {
  open(key: string): Promise<Readable | null>;
  put(key: string, body: Buffer): Promise<void>;
  describe(): string;
}

export interface LivePointer {
  release: string;
  deployed: string;
}

interface ReleaseFile {
  key: string;
  path: string;
}

export interface WebBundle {
  id: string;
  assets: ReleaseFile[];
  documents: ReleaseFile[];
}

const LIVE_KEY = "live.json";
const RELEASE_ID = /^[0-9a-f]{64}$/;
const UPLOAD_WORKERS = 8;

const releaseKey = (id: string, name: string): string => `releases/${id}/${name}`;
const isEntryDocument = (file: ReleaseFile): boolean => file.key.endsWith("/index.html");

export function createS3WebReleaseStore(options: {
  bucket: string;
  prefix?: string;
  region?: string;
  _client?: S3Send;
}): WebReleaseStore {
  const root = `${options.prefix ?? ""}web-ui/`;
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
      const staging = `${path}.${process.pid}.tmp`;
      await writeFile(staging, body);
      await rename(staging, path);
    },
    describe: () => `${dir}${sep}`,
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
  const text = (await readAll(stream)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${store.describe()}${LIVE_KEY} is not JSON: ${text}`, { cause: error });
  }
  const { release, deployed } = (parsed ?? {}) as Partial<Record<keyof LivePointer, unknown>>;
  if (typeof release !== "string" || !RELEASE_ID.test(release))
    throw new Error(`${store.describe()}${LIVE_KEY} names no release: ${text}`);
  return { release, deployed: typeof deployed === "string" ? deployed : "" };
}

async function writeLivePointer(store: WebReleaseStore, pointer: LivePointer): Promise<void> {
  await store.put(LIVE_KEY, Buffer.from(`${JSON.stringify(pointer)}\n`));
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(dir, path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export async function readWebBundle(dir: string): Promise<WebBundle> {
  const files = (await walk(dir)).sort();
  if (!files.includes("index.html")) throw new Error(`${join(dir, "index.html")} is missing; build the web UI first`);
  const id = createHash("sha256");
  for (const file of files) {
    const digest = createHash("sha256")
      .update(await readFile(join(dir, file)))
      .digest("hex");
    id.update(`${file}\0${digest}\n`);
  }
  const releaseId = id.digest("hex");
  const assets: ReleaseFile[] = [];
  const documents: ReleaseFile[] = [];
  for (const file of files) {
    const path = join(dir, file);
    if (file.startsWith("assets/")) assets.push({ key: file, path });
    else documents.push({ key: releaseKey(releaseId, file), path });
  }
  return { id: releaseId, assets, documents };
}

async function uploadAll(store: WebReleaseStore, files: ReleaseFile[]): Promise<void> {
  const queue = [...files];
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file; file = queue.shift()) await store.put(file.key, await readFile(file.path));
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_WORKERS, queue.length) }, worker));
}

async function uploadWebBundle(store: WebReleaseStore, bundle: WebBundle): Promise<boolean> {
  const marker = await store.open(releaseKey(bundle.id, "index.html"));
  if (marker) {
    marker.destroy();
    return false;
  }
  await uploadAll(store, bundle.assets);
  await uploadAll(
    store,
    bundle.documents.filter((file) => !isEntryDocument(file)),
  );
  await uploadAll(store, bundle.documents.filter(isEntryDocument));
  return true;
}

export async function deployBundledRelease(
  store: WebReleaseStore,
  dir: string,
): Promise<{ id: string; uploaded: boolean; live: string }> {
  const bundle = await readWebBundle(dir);
  const uploaded = await uploadWebBundle(store, bundle);
  const pointer = await readLivePointer(store);
  if (pointer?.deployed === bundle.id) return { id: bundle.id, uploaded, live: pointer.release };
  await writeLivePointer(store, { release: bundle.id, deployed: bundle.id });
  return { id: bundle.id, uploaded, live: bundle.id };
}

interface WebReleaseFile {
  body: Readable;
  gzip: boolean;
}

export interface WebReleases {
  document(name: string): Promise<string>;
  file(path: string, gzip: boolean): Promise<WebReleaseFile | null>;
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
  let documents = new Map<string, string>();
  let documentsFor = "";

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

  return {
    live,
    async document(name) {
      const release = await live();
      if (documentsFor !== release) {
        documents = new Map();
        documentsFor = release;
      }
      const cached = documents.get(name);
      if (cached !== undefined) return cached;
      const stream = await store.open(releaseKey(release, name));
      if (!stream) throw new Error(`web UI release ${release} has no ${name} in ${store.describe()}`);
      const html = (await readAll(stream)).toString("utf8");
      if (documentsFor === release) documents.set(name, html);
      return html;
    },
    async file(path, gzip) {
      const key = path.startsWith("assets/") ? path : releaseKey(await live(), path);
      if (gzip) {
        const packed = await store.open(`${key}.gz`);
        if (packed) return { body: packed, gzip: true };
      }
      const plain = await store.open(key);
      return plain ? { body: plain, gzip: false } : null;
    },
  };
}
