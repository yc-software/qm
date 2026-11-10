import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface LivePointer {
  release: string;
  deployed: string;
}

export interface WebBundleLayout {
  id: string;
  assets: string[];
  documents: string[];
}

export const WEB_RELEASE_ROOT = "web-ui/";
export const LIVE_KEY = "live.json";
export const RELEASE_ID = /^[0-9a-f]{64}$/;

export const releaseKey = (id: string, name: string): string => `releases/${id}/${name}`;
export const releaseMarkerKey = (id: string): string => releaseKey(id, "index.html");
export const formatLivePointer = (pointer: LivePointer): string => `${JSON.stringify(pointer)}\n`;

export function parseLivePointer(text: string, where: string): LivePointer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not JSON: ${text}`, { cause: error });
  }
  const { release, deployed } = (parsed ?? {}) as Partial<Record<keyof LivePointer, unknown>>;
  if (typeof release !== "string" || !RELEASE_ID.test(release)) throw new Error(`${where} names no release: ${text}`);
  if (typeof deployed !== "string") throw new Error(`${where} names no deployed release: ${text}`);
  return { release, deployed };
}

export function readWebBundleLayout(dir: string): WebBundleLayout {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
  if (!files.includes("index.html")) throw new Error(`${join(dir, "index.html")} is missing; build the web UI first`);
  const id = createHash("sha256");
  for (const file of files) {
    const digest = createHash("sha256")
      .update(readFileSync(join(dir, file)))
      .digest("hex");
    id.update(`${file}\0${digest}\n`);
  }
  const documents = files.filter((file) => !file.startsWith("assets/") && file !== "index.html");
  return {
    id: id.digest("hex"),
    assets: files.filter((file) => file.startsWith("assets/")),
    documents: [...documents, "index.html"],
  };
}
