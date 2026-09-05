import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import type { Readable } from "node:stream";
import { isProbablyBinary } from "./seed.ts";
import { safeSkillFilePath } from "./skill-store.ts";
import type { FetchedRepo, RepoFile } from "./ingest.ts";

export const MAX_SKILL_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export class SkillPackArchiveError extends Error {}

export async function readSkillPackArchive(stream: AsyncIterable<Uint8Array>): Promise<FetchedRepo> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > MAX_SKILL_ARCHIVE_BYTES) throw new SkillPackArchiveError("skill pack ZIP exceeds 16 MiB");
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const files = await unzip(buffer).catch((error: unknown) => {
    throw new SkillPackArchiveError(error instanceof Error ? error.message : "invalid skill pack ZIP");
  });
  const filePaths = new Set(files.map((file) => file.path));
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (filePaths.has(parts.slice(0, i).join("/"))) {
        throw new SkillPackArchiveError(`conflicting ZIP path: ${file.path}`);
      }
    }
  }
  const first = files[0]?.path.split("/")[0];
  const wrapped = first && files.every((file) => file.path.startsWith(first + "/"));
  if (wrapped) for (const file of files) file.path = file.path.slice(first.length + 1);
  if (!files.some((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))) {
    throw new SkillPackArchiveError("ZIP does not contain a SKILL.md file");
  }
  return { commit: createHash("sha256").update(buffer).digest("hex"), files };
}

async function entryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream!)));
  });
}

function unzip(buffer: Buffer): Promise<RepoFile[]> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("invalid ZIP"));
      const files: RepoFile[] = [];
      const paths = new Set<string>();
      let total = 0;
      let count = 0;
      let failed = false;
      const fail = (cause: unknown): void => {
        failed = true;
        zip.close();
        reject(cause);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (!failed) resolve(files.sort((a, b) => a.path.localeCompare(b.path)));
      });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          count++;
          if (count > MAX_ENTRIES) throw new Error("skill pack ZIP exceeds 5000 entries");
          const directory = entry.fileName.endsWith("/");
          const path = safeSkillFilePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
          if (paths.has(path)) throw new Error(`duplicate ZIP path: ${path}`);
          paths.add(path);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode && mode !== (directory ? 0x4000 : 0x8000)) throw new Error(`unsupported ZIP entry: ${path}`);
          if (entry.generalPurposeBitFlag & 1) throw new Error("encrypted skill pack ZIPs are not supported");
          if (directory) {
            if (entry.uncompressedSize) throw new Error(`invalid ZIP directory: ${path}`);
            zip.readEntry();
            return;
          }
          total += entry.uncompressedSize;
          if (total > MAX_UNPACKED_BYTES) throw new Error("expanded skill pack exceeds 32 MiB");
          const stream = await entryStream(zip, entry);
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of stream) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > entry.uncompressedSize || size > MAX_UNPACKED_BYTES) {
              throw new Error(`ZIP size mismatch: ${path}`);
            }
            chunks.push(bytes);
          }
          const bytes = Buffer.concat(chunks);
          if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32) {
            throw new Error(`ZIP integrity check failed: ${path}`);
          }
          if (path.split("/").includes(".git")) throw new Error("remove .git history before uploading the skill pack");
          if (!path.split("/").some((part) => part === "__MACOSX" || part === ".DS_Store")) {
            if (isProbablyBinary(bytes))
              throw new Error(`binary attachment is not supported: ${path}; upload a text-only skill pack`);
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            files.push({ path, text, binary: false });
          }
          if (!failed) zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}
