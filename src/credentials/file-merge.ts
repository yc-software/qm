import type { CredentialFile } from "./keychain.ts";

const TOKEN_CACHES: ReadonlyArray<{ directory: string; expiry: readonly string[]; tokens?: readonly string[] }> = [
  { directory: ".aws/sso/cache/", expiry: ["expiresAt"], tokens: ["accessToken", "expiresAt", "refreshToken"] },
  { directory: ".aws/cli/cache/", expiry: ["Credentials", "Expiration"] },
];

const tokenCache = (file: CredentialFile) => TOKEN_CACHES.find(({ directory }) => file.path.startsWith(directory));
const parsed = (file: CredentialFile): unknown =>
  JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8"));

export function credentialFileExpiry(file: CredentialFile): number | undefined {
  const declared = tokenCache(file)?.expiry;
  if (!declared) return undefined;
  let value: unknown;
  try {
    value = declared.reduce<unknown>(
      (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
      parsed(file),
    );
  } catch {
    value = file.path.endsWith(".json") ? "unparseable" : undefined;
  }
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isFinite(at)) return at;
  if (value !== undefined && value !== null)
    console.warn(`[credentials] ${file.path}: could not read its expiry; treating it as having none`);
  return undefined;
}

function refreshRefusal(
  ours: CredentialFile | undefined,
  theirs: CredentialFile | undefined,
  inBaseline: boolean,
): string | undefined {
  if (!ours) return "deleted";
  if (!theirs) return inBaseline ? "no longer in the saved login" : "a new file";
  const tokens = tokenCache(ours)?.tokens;
  if (!tokens) return "not a refreshable token cache";
  const [refreshed, current] = [ours, theirs].map((file) => {
    try {
      const value = parsed(file);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  });
  if (!refreshed || !current) return "unreadable";
  const fixed = [...new Set([...Object.keys(refreshed), ...Object.keys(current)])].filter(
    (key) => !tokens.includes(key),
  );
  return fixed.every((key) => JSON.stringify(refreshed[key]) === JSON.stringify(current[key]))
    ? undefined
    : "changed beyond its token fields";
}

export interface CredentialFileMerge {
  files: CredentialFile[];
  overruled: string[];
  withheld: Array<{ path: string; reason: string }>;
  byExpiry: Array<{ path: string; kept: "stored" | "refreshed" }>;
}

export function mergeCredentialFiles(input: {
  baseline: ReadonlyMap<string, string>;
  stored: readonly CredentialFile[];
  refreshed: readonly CredentialFile[];
  hash(file: CredentialFile): string;
  refreshOnly: boolean;
}): CredentialFileMerge {
  const version = (file: CredentialFile | undefined) => (file ? input.hash(file) : undefined);
  const stored = new Map(input.stored.map((file) => [file.path, file]));
  const refreshed = new Map(input.refreshed.map((file) => [file.path, file]));
  const merged: CredentialFileMerge = { files: [], overruled: [], withheld: [], byExpiry: [] };
  for (const path of [...new Set([...stored.keys(), ...refreshed.keys()])].sort()) {
    const ours = refreshed.get(path);
    const theirs = stored.get(path);
    const base = input.baseline.get(path);
    let pick = theirs;
    if (version(ours) !== version(theirs) && version(ours) !== base) {
      const reason = input.refreshOnly ? refreshRefusal(ours, theirs, base !== undefined) : undefined;
      if (reason) {
        merged.withheld.push({ path, reason });
        if (theirs) merged.files.push(theirs);
        continue;
      }
      const a = ours && credentialFileExpiry(ours);
      const b = theirs && credentialFileExpiry(theirs);
      const decided = version(theirs) !== base && !!theirs && a !== undefined && b !== undefined && a !== b;
      if (version(theirs) === base || !theirs || (decided && a > b)) pick = ours;
      else if (!decided) merged.overruled.push(path);
      if (decided) merged.byExpiry.push({ path, kept: pick === ours ? "refreshed" : "stored" });
    }
    if (pick) merged.files.push(pick);
  }
  return merged;
}
