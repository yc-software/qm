import { timingSafeEqual } from "node:crypto";
import { canonicalPayload, signRequest } from "./source-auth-sign.ts";

export interface SignedRequestVerifier {
  verify(input: {
    method: string;
    pathWithQuery: string;
    body: string;
    timestamp: string | undefined;
    signature: string | undefined;
  }): boolean;
}

export function createSignedRequestVerifier(
  secret: string | undefined,
  now: () => number = Date.now,
  replayWindowMs = 5 * 60_000,
): SignedRequestVerifier {
  const seen = new Map<string, number>();
  return {
    verify(input) {
      if (!secret || !input.signature) return false;
      const timestamp = Number(input.timestamp);
      const nowMs = now();
      if (!Number.isFinite(timestamp) || Math.abs(nowMs - timestamp * 1000) > replayWindowMs) return false;
      const expected = Buffer.from(
        signRequest(secret, timestamp, canonicalPayload(input.method, input.pathWithQuery, input.body)),
      );
      const got = Buffer.from(input.signature);
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return false;
      for (const [value, expiresAt] of seen) if (expiresAt <= nowMs) seen.delete(value);
      if (seen.has(input.signature)) return false;
      seen.set(input.signature, timestamp * 1000 + replayWindowMs);
      return true;
    },
  };
}
