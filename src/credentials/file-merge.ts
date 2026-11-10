import type { CredentialFile } from "./keychain.ts";

const EXPIRY_FIELDS = [["expiresAt"], ["Credentials", "Expiration"]];

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return timestamp(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function credentialFileExpiry(file: CredentialFile): number | undefined {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  for (const path of EXPIRY_FIELDS) {
    const value = path.reduce<unknown>(
      (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
      json,
    );
    const at = timestamp(value);
    if (at !== undefined) return at;
  }
  return undefined;
}

export interface CredentialFileMerge {
  files: CredentialFile[];
  overruled: string[];
}

export function mergeCredentialFiles(input: {
  baseline: ReadonlyMap<string, string>;
  stored: readonly CredentialFile[];
  refreshed: readonly CredentialFile[];
  hash(file: CredentialFile): string;
}): CredentialFileMerge {
  const version = (file: CredentialFile | undefined) => (file ? input.hash(file) : undefined);
  const stored = new Map(input.stored.map((file) => [file.path, file]));
  const refreshed = new Map(input.refreshed.map((file) => [file.path, file]));
  const merged: CredentialFileMerge = { files: [], overruled: [] };
  for (const path of [...new Set([...stored.keys(), ...refreshed.keys()])].sort()) {
    const ours = refreshed.get(path);
    const pick = choose(version, input.baseline.get(path), ours, stored.get(path));
    if (pick) merged.files.push(pick);
    if (version(ours) !== input.baseline.get(path) && version(pick) !== version(ours)) merged.overruled.push(path);
  }
  return merged;
}

function choose(
  version: (file: CredentialFile | undefined) => string | undefined,
  base: string | undefined,
  ours: CredentialFile | undefined,
  theirs: CredentialFile | undefined,
): CredentialFile | undefined {
  if (version(ours) === version(theirs) || version(ours) === base) return theirs;
  if (version(theirs) === base) return ours;
  if (ours && theirs) {
    const a = credentialFileExpiry(ours);
    const b = credentialFileExpiry(theirs);
    if (a !== undefined && b !== undefined && a !== b) return a > b ? ours : theirs;
  }
  return theirs ?? ours;
}
