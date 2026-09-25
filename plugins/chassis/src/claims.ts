import { createHmac } from "node:crypto";
import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";
import { errMessage } from "./errors.ts";

export interface ClaimStore {
  claimFirst(ids: readonly string[], expiresAtMs: number): Promise<string | null>;
}

const CLAIM_PATH = "/v1/auth/broker/claim";
const CLAIM_TIMEOUT_MS = 4_000;

export class ClaimStoreUnavailableError extends Error {}

export function coreClaimStore(coreApiUrl: string, signingSecret: string | undefined, label = "chassis"): ClaimStore {
  return {
    async claimFirst(ids, expiresAtMs) {
      const path = withSourceAuthNonce(CLAIM_PATH, signingSecret);
      const body = JSON.stringify({ ids, expiresAtMs });
      try {
        const r = await fetch(`${coreApiUrl}${path}`, {
          method: "POST",
          headers: signedHeaders(signingSecret, "POST", path, body),
          body,
          signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
        });
        if (r.status >= 500) {
          throw new ClaimStoreUnavailableError(`core answered the claim endpoint with HTTP ${r.status}`);
        }
        if (!r.ok) {
          console.error(`[${label}] core refused a single-use claim: HTTP ${r.status}`);
          return null;
        }
        const parsed = (await r.json()) as { claimed?: unknown };
        return typeof parsed.claimed === "string" ? parsed.claimed : null;
      } catch (e) {
        if (e instanceof ClaimStoreUnavailableError) {
          console.error(`[${label}] ${e.message} — failing closed, this is a core outage, not a rate limit`);
          throw e;
        }
        const unavailable = new ClaimStoreUnavailableError(`core claim store unreachable: ${errMessage(e)}`);
        console.error(`[${label}] ${unavailable.message} — failing closed, this is a core outage, not a rate limit`);
        throw unavailable;
      }
    },
  };
}

export async function claimOnce(store: ClaimStore, id: string, expiresAtMs: number): Promise<boolean> {
  return (await store.claimFirst([id], expiresAtMs)) !== null;
}

export async function withinRateLimit(
  store: ClaimStore,
  args: { secret: string; kind: string; value: string; limit: number; windowS: number; nowMs: number },
): Promise<boolean> {
  const window = Math.floor(args.nowMs / (args.windowS * 1000));
  const bucket = createHmac("sha256", args.secret)
    .update(`ratelimit.v1|${args.kind}|${args.value}`, "utf8")
    .digest("base64url")
    .slice(0, 22);
  const slots = Array.from({ length: args.limit }, (_, slot) => `rate:${args.kind}:${bucket}:${window}:${slot}`);
  return (await store.claimFirst(slots, (window + 1) * args.windowS * 1000)) !== null;
}
