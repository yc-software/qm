import type { CredentialFile } from "./keychain.ts";

/**
 * Reads an expiry out of a credential file's parsed JSON. Probes are tried in order;
 * the first one that yields a usable timestamp wins.
 */
export type ExpiryProbe = (json: unknown) => unknown;

const field =
  (...path: string[]): ExpiryProbe =>
  (json) =>
    path.reduce<unknown>(
      (value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined),
      json,
    );

/** Common expiry fields: AWS SSO token cache (`expiresAt`), AWS CLI/STS cache (`Credentials.Expiration`), OAuth-style token files. */
const EXPIRY_PROBES: readonly ExpiryProbe[] = [
  field("expiresAt"),
  field("expires_at"),
  field("Credentials", "Expiration"),
  field("Expiration"),
  field("expiration"),
  field("expiry"),
];

function timestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return timestamp(Number(value));
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** The file's expiry in epoch ms when its JSON content names one, else undefined. */
export function credentialFileExpiry(
  file: CredentialFile,
  probes: readonly ExpiryProbe[] = EXPIRY_PROBES,
): number | undefined {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  for (const probe of probes) {
    const at = timestamp(probe(json));
    if (at !== undefined) return at;
  }
  return undefined;
}

export interface CredentialFileMergeInput {
  /** Path → hash of the files the command started with; null when that snapshot is unknown. */
  baseline: ReadonlyMap<string, string> | null;
  /** What the keychain holds now (possibly saved by another command meanwhile). */
  stored: readonly CredentialFile[];
  /** What the command left behind. A baseline path missing here was deleted by the command. */
  refreshed: readonly CredentialFile[];
  hash(file: CredentialFile): string;
  probes?: readonly ExpiryProbe[];
}

/**
 * Merges a command's refreshed credential files into the stored ones, one path at a time:
 * 1. Same on both sides → keep it.
 * 2. Only one side changed since the command's baseline → keep that side's version
 *    (including a deletion).
 * 3. Both changed (or the baseline is unknown) and both versions carry a readable, different
 *    expiry → keep the later expiry, so a fresh login or newer refresh wins whichever saved first.
 * 4. Otherwise keep whichever side still has the file; if both do, keep the stored version
 *    (first save wins), because other commands may already be using it.
 */
export function mergeCredentialFiles(input: CredentialFileMergeInput): CredentialFile[] {
  const stored = new Map(input.stored.map((file) => [file.path, file]));
  const refreshed = new Map(input.refreshed.map((file) => [file.path, file]));
  const paths = [...new Set([...stored.keys(), ...refreshed.keys()])].sort();
  return paths.flatMap((path) => {
    const pick = choose(input, path, refreshed.get(path), stored.get(path));
    return pick ? [pick] : [];
  });
}

function choose(
  input: CredentialFileMergeInput,
  path: string,
  ours: CredentialFile | undefined,
  theirs: CredentialFile | undefined,
): CredentialFile | undefined {
  const version = (file: CredentialFile | undefined) => (file ? input.hash(file) : undefined);
  if (version(ours) === version(theirs)) return theirs;
  if (input.baseline) {
    const base = input.baseline.get(path);
    if (version(ours) === base) return theirs;
    if (version(theirs) === base) return ours;
  }
  if (ours && theirs) {
    const a = credentialFileExpiry(ours, input.probes);
    const b = credentialFileExpiry(theirs, input.probes);
    if (a !== undefined && b !== undefined && a !== b) return a > b ? ours : theirs;
  }
  return theirs ?? ours;
}
