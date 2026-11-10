import type { CredentialFile } from "./keychain.ts";

const EXPIRY_FIELDS: ReadonlyArray<{ directory: string; field: readonly string[] }> = [
  { directory: ".aws/sso/cache/", field: ["expiresAt"] },
  { directory: ".aws/cli/cache/", field: ["Credentials", "Expiration"] },
];

export function credentialFileExpiry(file: CredentialFile): number | undefined {
  const declared = EXPIRY_FIELDS.find(({ directory }) => file.path.startsWith(directory));
  if (!declared) return undefined;
  let value: unknown;
  try {
    value = declared.field.reduce<unknown>(
      (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
      JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")),
    );
  } catch {
    return undefined;
  }
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : undefined;
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
    const theirs = stored.get(path);
    const base = input.baseline.get(path);
    let pick = theirs;
    if (version(ours) !== version(theirs) && version(ours) !== base) {
      const a = ours && credentialFileExpiry(ours);
      const b = theirs && credentialFileExpiry(theirs);
      if (version(theirs) === base || !theirs || (a !== undefined && b !== undefined && a > b)) pick = ours;
      else if (a === undefined || b === undefined || a === b) merged.overruled.push(path);
    }
    if (pick) merged.files.push(pick);
  }
  return merged;
}
