import { scrypt, timingSafeEqual } from "node:crypto";

const HASH_PATTERN = /^scrypt\$32768\$8\$3\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;
const DUMMY_HASH = `scrypt$32768$8$3$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

export function readPasswordHashes(raw: string | undefined): ReadonlyMap<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const hashes = new Map<string, string>();
    for (const [email, hash] of Object.entries(parsed)) {
      const normalized = email.trim().toLowerCase();
      if (hashes.has(normalized) || typeof hash !== "string") return null;
      const parts = HASH_PATTERN.exec(hash);
      if (!parts || parts.slice(1).some((part) => Buffer.from(part, "base64url").toString("base64url") !== part))
        return null;
      hashes.set(normalized, hash);
    }
    return hashes.size ? hashes : null;
  } catch {
    return null;
  }
}

export function validPassword(password: string): boolean {
  const length = [...password].length;
  return length >= 15 && length <= 128;
}

export async function verifyPassword(password: string, hash: string | undefined): Promise<boolean> {
  if (!validPassword(password)) return false;
  const parts = HASH_PATTERN.exec(hash ?? DUMMY_HASH);
  if (!parts) return false;
  const salt = Buffer.from(parts[1]!, "base64url");
  const expected = Buffer.from(parts[2]!, "base64url");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  return timingSafeEqual(derived, expected) && hash !== undefined;
}
