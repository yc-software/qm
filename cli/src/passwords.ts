import { randomBytes, scrypt } from "node:crypto";
import { CliError } from "./log.ts";

export function normalizePasswordEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(normalized)) {
    throw new CliError("a valid email address is required");
  }
  return normalized;
}

export function parsePasswordHashes(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const entries = Object.entries(parsed);
    if (entries.length === 0) throw new Error();
    for (const [email, hash] of entries) {
      if (normalizePasswordEmail(email) !== email || typeof hash !== "string") throw new Error();
      const parts = /^scrypt\$32768\$8\$3\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(hash);
      if (!parts) throw new Error();
      for (const part of parts.slice(1)) {
        if (Buffer.from(part!, "base64url").toString("base64url") !== part) throw new Error();
      }
    }
    return Object.fromEntries(entries);
  } catch {
    throw new CliError(
      "AUTH_PASSWORD_HASHES must contain normalized email addresses and valid scrypt hashes; use qm password <email>",
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  const length = Array.from(password).length;
  if (length < 15 || length > 128) throw new CliError("passwords must contain 15 to 128 characters");
  const salt = randomBytes(16);
  const hash = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  return `scrypt$32768$8$3$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function promptPasswordHash(email: string, ask: (question: string) => Promise<string>): Promise<string> {
  const password = await ask(`Password for ${email}`);
  const confirmation = await ask(`Confirm password for ${email}`);
  if (password !== confirmation) throw new CliError("passwords do not match; no password was saved");
  return hashPassword(password);
}
