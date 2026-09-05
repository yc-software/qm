import { createHash, timingSafeEqual } from "node:crypto";
import { personKey } from "../directory/person.ts";

/**
 * The break-glass recovery path.
 *
 * A deployment whose sign-in transport can stop working — a password
 * deployment on a host with no outbound mail route is the case this was
 * written for — cannot recover by redeploying: the previous revision cannot
 * sign anyone in either, including the administrator handling the incident.
 *
 * Break-glass is the way back in, and it is deliberately small. It is
 * configured only at boot, from two environment variables that nothing in the
 * running system can set. It resets one named principal's password and
 * restores their administrator grant. It mints no session, issues no token,
 * and reads nothing. Every use is audited under `break-glass.recover`.
 *
 * Unconfigured, the route does not exist.
 */
export interface BreakGlassConfig {
  /** The only principal that may be recovered. */
  principalId: string;
  /** sha256 of the shared secret, so the plaintext is not held in memory. */
  secretHash: Buffer;
}

export const MIN_SECRET_LENGTH = 32;

export function readBreakGlassConfig(env: NodeJS.ProcessEnv): BreakGlassConfig | undefined {
  const principalId = env.QM_BREAK_GLASS_PRINCIPAL?.trim();
  const secret = env.QM_BREAK_GLASS_SECRET ?? "";
  if (!principalId && !secret) return undefined;
  if (!principalId || secret.trim().length < MIN_SECRET_LENGTH) {
    console.error(
      `[break-glass] disabled: QM_BREAK_GLASS_PRINCIPAL and a QM_BREAK_GLASS_SECRET of at least ${MIN_SECRET_LENGTH} characters are both required`,
    );
    return undefined;
  }
  return { principalId, secretHash: createHash("sha256").update(secret, "utf8").digest() };
}

export function breakGlassSecretMatches(cfg: BreakGlassConfig, offered: string): boolean {
  const digest = createHash("sha256").update(offered, "utf8").digest();
  return timingSafeEqual(digest, cfg.secretHash);
}

export function breakGlassCovers(cfg: BreakGlassConfig, principalId: string): boolean {
  const expected = personKey(cfg.principalId);
  return expected !== "" && expected === personKey(principalId);
}
