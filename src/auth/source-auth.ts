import { signRequest as signCanonical } from "./source-auth-sign.ts";
import { createMemoryReplayDedupe, type ReplayDedupe } from "./replay-dedupe.ts";
import { constantTimeEqual } from "../util/crypto.ts";

export const SOURCE_AUTH_REPLAY_WINDOW_MS = 5 * 60_000;
export const MIN_SIGNING_SECRET_LENGTH = 32;

export function isStrongSigningSecret(secret: string | undefined): secret is string {
  return (secret?.trim().length ?? 0) >= MIN_SIGNING_SECRET_LENGTH;
}

interface SourceAuthRequest {
  signature: string;
  timestamp: number;
  body: string;
  eventId: string;
}

export type SourceAuthResult = { ok: true } | { ok: false; reason: string };

export interface SourceAuthOptions {
  signingSecret: string;
  now?: () => number;
  replayWindowMs?: number;
  dedupe?: ReplayDedupe;
}

export interface SourceAuth {
  verify(req: SourceAuthRequest): Promise<SourceAuthResult>;
}

export function signRequest(secret: string, timestamp: number, body: string): string {
  return signCanonical(secret, timestamp, body);
}

export function verifySignature(
  secret: string,
  req: { signature: string; timestamp: number; body: string },
  now: number,
  replayWindowMs: number,
): SourceAuthResult {
  if (!req.signature) {
    return { ok: false, reason: "missing signature (unsigned request)" };
  }
  if (!Number.isFinite(req.timestamp)) {
    return { ok: false, reason: "invalid timestamp" };
  }
  if (Math.abs(now - req.timestamp * 1000) > replayWindowMs) {
    return { ok: false, reason: "stale timestamp (replay protection)" };
  }
  if (!constantTimeEqual(signRequest(secret, req.timestamp, req.body), req.signature)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

export function createSourceAuth(opts: SourceAuthOptions): SourceAuth {
  const now = opts.now ?? (() => Date.now());
  const replayWindowMs = opts.replayWindowMs ?? SOURCE_AUTH_REPLAY_WINDOW_MS;
  const dedupe = opts.dedupe ?? createMemoryReplayDedupe(now);

  return {
    async verify(req) {
      const t = now();
      const sig = verifySignature(opts.signingSecret, req, t, replayWindowMs);
      if (!sig.ok) return sig;
      const expiresAtMs = req.timestamp * 1000 + replayWindowMs;
      if (!(await dedupe.claim(req.eventId, expiresAtMs))) {
        return { ok: false, reason: "duplicate event (already processed)" };
      }
      return { ok: true };
    },
  };
}
