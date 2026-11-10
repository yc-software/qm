import type { CredentialFile } from "./keychain.ts";

export type ExpiryProbe = (json: unknown) => unknown;

const field =
  (...path: string[]): ExpiryProbe =>
  (json) =>
    path.reduce<unknown>(
      (value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined),
      json,
    );

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
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestamp(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

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
  baseline: ReadonlyMap<string, string>;
  stored: readonly CredentialFile[];
  refreshed: readonly CredentialFile[];
  hash(file: CredentialFile): string;
  probes?: readonly ExpiryProbe[];
}

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
  const base = input.baseline.get(path);
  if (version(ours) === base) return theirs;
  if (version(theirs) === base) return ours;
  if (ours && theirs) {
    const a = credentialFileExpiry(ours, input.probes);
    const b = credentialFileExpiry(theirs, input.probes);
    if (a !== undefined && b !== undefined && a !== b) return a > b ? ours : theirs;
  }
  return theirs ?? ours;
}
