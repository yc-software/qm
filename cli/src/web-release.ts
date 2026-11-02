import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

export function parseLivePointer(text: string, where: string): LivePointer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not JSON: ${text}`, { cause: error });
  }
  const { release, deployed } = (parsed ?? {}) as Partial<Record<keyof LivePointer, unknown>>;
  if (typeof release !== "string" || !RELEASE_ID.test(release)) throw new Error(`${where} names no release: ${text}`);
  return { release, deployed: typeof deployed === "string" ? deployed : "" };
}

function bundleFiles(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return bundleFiles(dir, path);
    return entry.isFile() ? [path] : [];
  });
}

export function readWebBundleLayout(dir: string): WebBundleLayout {
  const files = bundleFiles(dir).sort();
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
