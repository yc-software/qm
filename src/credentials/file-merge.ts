import type { CredentialFile } from "./keychain.ts";

const TOKEN_CACHES: ReadonlyArray<{ directory: string; expiry: readonly string[]; account?: readonly string[] }> = [
  { directory: ".aws/sso/cache/", expiry: ["expiresAt"], account: ["startUrl"] },
  { directory: ".aws/cli/cache/", expiry: ["Credentials", "Expiration"] },
];

function cacheField(file: CredentialFile, field: "expiry" | "account"): unknown {
  const declared = TOKEN_CACHES.find(({ directory }) => file.path.startsWith(directory))?.[field];
  if (!declared) return undefined;
  return declared.reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")),
  );
}

export function credentialFileExpiry(file: CredentialFile): number | undefined {
  let value: unknown;
  try {
    value = cacheField(file, "expiry");
  } catch {
    value = file.path.endsWith(".json") ? "unparseable" : undefined;
  }
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isFinite(at)) return at;
  if (value !== undefined && value !== null)
    console.warn(`[credentials] ${file.path}: could not read its expiry; treating it as having none`);
  return undefined;
}

function refreshRefusal(ours: CredentialFile | undefined, theirs: CredentialFile | undefined): string | undefined {
  if (!ours) return "deleted";
  if (!theirs) return "a new file";
  const cache = TOKEN_CACHES.find(({ directory }) => ours.path.startsWith(directory));
  if (!cache) return "not a token cache";
  if (!cache.account) return "a token cache with no account field";
  const accounts = [ours, theirs].map((file) => {
    try {
      return cacheField(file, "account");
    } catch {
      return undefined;
    }
  });
  if (accounts.some((account) => typeof account !== "string" || !account)) return "account field unreadable";
  return accounts[0] === accounts[1] ? undefined : "account changed";
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
      const reason = input.refreshOnly ? refreshRefusal(ours, theirs) : undefined;
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
