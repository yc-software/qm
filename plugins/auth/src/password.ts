import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCHEME = "scrypt";
const DEFAULT_LOG2_N = 15;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_LOG2_N = 20;
const MAX_PASSWORD_BYTES = 1024;
const MIN_PASSWORD_LENGTH = 12;

interface ParsedHash {
  log2N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function derive(password: string, salt: Buffer, params: { log2N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      { N: 2 ** params.log2N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `passwords must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return "password is too long";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, { log2N: DEFAULT_LOG2_N, r: DEFAULT_R, p: DEFAULT_P });
  return [SCHEME, DEFAULT_LOG2_N, DEFAULT_R, DEFAULT_P, salt.toString("base64url"), key.toString("base64url")].join(
    "$",
  );
}

export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== SCHEME) return null;
  const [, rawLog2N, rawR, rawP, rawSalt, rawKey] = parts as [string, string, string, string, string, string];
  if (![rawLog2N, rawR, rawP].every((value) => /^\d{1,2}$/.test(value))) return null;
  const log2N = Number(rawLog2N);
  const r = Number(rawR);
  const p = Number(rawP);
  if (log2N < 10 || log2N > MAX_LOG2_N || r < 1 || r > 32 || p < 1 || p > 16) return null;
  if (!/^[A-Za-z0-9_-]{16,}$/.test(rawSalt) || !/^[A-Za-z0-9_-]{43}$/.test(rawKey)) return null;
  const salt = Buffer.from(rawSalt, "base64url");
  const key = Buffer.from(rawKey, "base64url");
  if (salt.length < 8 || key.length !== KEY_BYTES) return null;
  return { log2N, r, p, salt, key };
}

const DECOY = parsePasswordHash(
  `${SCHEME}$${DEFAULT_LOG2_N}$${DEFAULT_R}$${DEFAULT_P}$${Buffer.alloc(SALT_BYTES).toString("base64url")}$${Buffer.alloc(KEY_BYTES).toString("base64url")}`,
)!;

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const parsed = stored ? parsePasswordHash(stored) : null;
  const target = parsed ?? DECOY;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;
  const key = await derive(password, target.salt, target);
  return timingSafeEqual(key, target.key) && parsed !== null;
}
