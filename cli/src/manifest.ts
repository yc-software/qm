import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ServiceName } from "./services.ts";

interface ImageManifest {
  sandboxBase: string;
  services: Record<string, string>;
}

const readSibling = <T>(rel: string): T => {
  const direct = fileURLToPath(new URL(rel, import.meta.url));
  const path = existsSync(direct) ? direct : fileURLToPath(new URL(`../${rel}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
};

let cached: ImageManifest | undefined;

function loadManifest(): ImageManifest {
  if (cached) return cached;
  const raw = readSibling<ImageManifest & { "//"?: string }>("../manifest.json");
  delete raw["//"];
  cached = raw;
  return raw;
}

let cachedPackage: { name: string; version: string } | undefined;

function cliPackage(): { name: string; version: string } {
  if (cachedPackage) return cachedPackage;
  const raw = readSibling<{ name: string; version: string }>("../package.json");
  cachedPackage = { name: raw.name, version: raw.version };
  return cachedPackage;
}

export function cliPackageName(): string {
  return cliPackage().name;
}

export function cliVersion(): string {
  return cliPackage().version;
}

export function manifestRef(service: ServiceName): string {
  const m = loadManifest();
  const ref = m.services[service];
  if (!ref) throw new Error(`no image manifest entry for service "${service}"`);
  return immutableRef(ref, service);
}

export function sandboxBaseRef(): string {
  return immutableRef(loadManifest().sandboxBase, "sandbox base");
}

function immutableRef(ref: string, name: string): string {
  if (!/@sha256:[a-f0-9]{64}$/.test(ref)) throw new Error(`image manifest entry for ${name} is not digest-pinned`);
  return ref;
}
