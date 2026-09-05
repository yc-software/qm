import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { DurableMap } from "../persistence/durable-map.ts";
import { personKey } from "../directory/person.ts";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing for administrator-created accounts.
 *
 * The encoding is algorithm-tagged (`scrypt$N$r$p$salt$hash`) so a future
 * algorithm can be introduced without a migration: verification dispatches on
 * the tag, and a credential is re-hashed with the current parameters the next
 * time it is set. Today the only tag is `scrypt`, the memory-hard KDF Node
 * ships in `node:crypto` — deliberately, so this needs no native dependency.
 */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 } as const;

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

export interface PasswordCredential {
  /** The person key this credential belongs to, kept for readability of the row. */
  principalId: string;
  hash: string;
  /** The holder must choose a new password before reaching any surface. */
  mustChange: boolean;
  updatedAt: number;
  /** Principal id of the administrator who last set it, or "break-glass". */
  updatedBy: string;
}

type PasswordVerdict =
  { ok: true; principalId: string; mustChange: boolean } | { ok: false; reason: "no-match" | "unavailable" };

export function passwordProblem(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH)
    return `a password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `a password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function passwordMatches(stored: string, password: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts as [string, string, string, string, string, string];
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 1 << 12 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let expected: Buffer;
  let salt: Buffer;
  try {
    salt = Buffer.from(rawSalt, "base64url");
    expected = Buffer.from(rawHash, "base64url");
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * A hash of a value nobody holds. Verifying an unknown identifier against this
 * costs the same as verifying a real one, so a wrong password and an account
 * that does not exist cannot be told apart by how long the answer takes.
 */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword(randomBytes(32).toString("base64url"));
  return decoyHash;
}

export interface PasswordCredentialStore {
  get(identifier: string): Promise<PasswordCredential | null>;
  list(): Promise<PasswordCredential[]>;
  set(identifier: string, password: string, by: string, mustChange: boolean): Promise<void>;
  remove(identifier: string): Promise<void>;
  verify(identifier: string, password: string): Promise<PasswordVerdict>;
  /** Verify the current password and replace it in one step, clearing mustChange. */
  change(identifier: string, current: string, next: string): Promise<PasswordVerdict>;
}

export function createPasswordCredentialStore(backing: DurableMap<PasswordCredential>): PasswordCredentialStore {
  const read = async (identifier: string): Promise<PasswordCredential | null> => {
    const key = personKey(identifier);
    if (!key) return null;
    return backing.get(key);
  };

  async function verify(identifier: string, password: string): Promise<PasswordVerdict> {
    let record: PasswordCredential | null;
    try {
      record = await read(identifier);
    } catch (e) {
      // A credential store that cannot answer refuses. It never admits.
      console.error(`[password] credential lookup failed: ${String(e)}`);
      return { ok: false, reason: "unavailable" };
    }
    const stored = record?.hash ?? (await decoy());
    const matched = await passwordMatches(stored, password);
    if (!record || !matched) return { ok: false, reason: "no-match" };
    return { ok: true, principalId: record.principalId, mustChange: record.mustChange };
  }

  return {
    get: read,
    async list() {
      return backing.all();
    },
    async set(identifier, password, by, mustChange) {
      const key = personKey(identifier);
      if (!key) throw new Error("a password credential needs an identifier");
      const problem = passwordProblem(password);
      if (problem) throw new Error(problem);
      await backing.put(key, {
        principalId: identifier,
        hash: await hashPassword(password),
        mustChange,
        updatedAt: Date.now(),
        updatedBy: by,
      });
    },
    async remove(identifier) {
      const key = personKey(identifier);
      if (key) await backing.delete(key);
    },
    verify,
    async change(identifier, current, next) {
      const problem = passwordProblem(next);
      if (problem) throw new Error(problem);
      const verdict = await verify(identifier, current);
      if (!verdict.ok) return verdict;
      const key = personKey(identifier);
      await backing.put(key, {
        principalId: verdict.principalId,
        hash: await hashPassword(next),
        mustChange: false,
        updatedAt: Date.now(),
        updatedBy: verdict.principalId,
      });
      return { ok: true, principalId: verdict.principalId, mustChange: false };
    },
  };
}
