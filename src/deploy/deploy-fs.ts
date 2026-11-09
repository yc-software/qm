import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { trimTrailing, trimTrailingSlashes } from "../util/text.ts";

export function bytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? Buffer.from(data, "utf8") : data;
}

function isGitMetadataComponent(part: string): boolean {
  const p = trimTrailing(part.normalize("NFC"), (char) => /[.\s]/.test(char)).toLowerCase();
  return p === ".git" || /^git~[0-9]+$/.test(p);
}

export function carriesGitMetadata(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).some(isGitMetadataComponent);
}

export function normalizeRelPath(path: string): string {
  const p = trimTrailingSlashes(path.replace(/\\/g, "/").replace(/^\.\/+/, ""));
  const parts = p.split("/").filter(Boolean);
  if (
    !parts.length ||
    path.startsWith("/") ||
    parts.some((part) => part === "." || part === ".." || part.includes("\0")) ||
    parts.some(isGitMetadataComponent)
  ) {
    throw new Error(`invalid deploy path: ${path}`);
  }
  return parts.join("/");
}

export function posixJoin(base: string, rel: string): string {
  return `${trimTrailingSlashes(base)}/${rel.replace(/^\/+/, "")}`;
}

export async function readTree(
  root: string,
  opts: { tolerateMissing?: boolean } = {},
): Promise<Array<{ path: string; data: Uint8Array }>> {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (e) {
    if (opts.tolerateMissing && (e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: Array<{ path: string; data: Uint8Array }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out.push({ path: relative(root, full).split(sep).join("/"), data: await readFile(full) });
  }
  return out;
}
