export interface DropEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(onOk: (file: File) => void, onErr: (err: unknown) => void): void;
  createReader?(): DropReaderLike;
}

interface DropReaderLike {
  readEntries(onOk: (entries: DropEntryLike[]) => void, onErr: (err: unknown) => void): void;
}

export interface DropItemLike {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?(): DropEntryLike | null;
}

export interface DropSplit {
  files: File[];
  folders: DropEntryLike[];
}

export function splitDropItems(items: DropItemLike[]): DropSplit {
  const files: File[] = [];
  const folders: DropEntryLike[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      folders.push(entry);
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}

const MAX_FOLDER_FILES = 2000;
const MAX_FOLDER_BYTES = 200 * 1024 * 1024;

const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export class FolderDropError extends Error {}

interface FolderCaps {
  maxFiles: number;
  maxBytes: number;
}

const DEFAULT_CAPS: FolderCaps = { maxFiles: MAX_FOLDER_FILES, maxBytes: MAX_FOLDER_BYTES };

async function readAllEntries(dir: DropEntryLike): Promise<DropEntryLike[]> {
  const reader = dir.createReader?.();
  if (!reader) return [];
  const all: DropEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<DropEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

async function collectFolder(root: DropEntryLike, caps: FolderCaps): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = [];
  let bytes = 0;
  const walk = async (dir: DropEntryLike, prefix: string): Promise<void> => {
    for (const entry of await readAllEntries(dir)) {
      if (entry.isDirectory) {
        await walk(entry, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile || !entry.file || JUNK_FILES.has(entry.name)) continue;
      if (out.length >= caps.maxFiles) {
        throw new FolderDropError(
          `"${root.name}" has too many files (over ${caps.maxFiles.toLocaleString()}) — zip it yourself or drop a subfolder.`,
        );
      }
      const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject));
      bytes += file.size;
      if (bytes > caps.maxBytes) {
        throw new FolderDropError(
          `"${root.name}" is too big (over ${Math.round(caps.maxBytes / (1024 * 1024))} MB) — zip it yourself or drop a subfolder.`,
        );
      }
      out.push({ path: `${prefix}${entry.name}`, file });
    }
  };
  await walk(root, "");
  return out;
}

export async function folderToZipFile(root: DropEntryLike, caps: FolderCaps = DEFAULT_CAPS): Promise<File> {
  const files = await collectFolder(root, caps);
  if (!files.length) throw new FolderDropError(`"${root.name}" has no files in it.`);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const { path, file } of files) zip.file(path, await file.arrayBuffer());
  const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return new File([bytes], `${root.name}.zip`, { type: "application/zip" });
}

export function isFolderReadError(err: unknown): boolean {
  return typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "NotFoundError";
}
