import { randomBytes } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { OAuthState } from "./oauth.ts";

/**
 * The authorize `state` parameter has to survive a provider round trip, and
 * providers cap its length — X rejects anything over 500 characters. Signing
 * the whole flow context into the parameter makes its size grow with the
 * principal id, redirect URI and returnTo path, so ordinary deployments
 * overflowed that cap. Keep the context here, keyed by a short opaque id, so
 * the parameter is a fixed 43 characters and the PKCE verifier never travels
 * through the browser.
 */
export interface OAuthFlowStore {
  start(state: Omit<OAuthState, "issuedAt" | "nonce">, now?: number): Promise<string>;
  finish(flowId: string, now?: number): Promise<OAuthState | null>;
}

const OAUTH_FLOW_TTL_MS = 10 * 60_000;

export function createOAuthFlowStore(
  backing: DurableMap<OAuthState>,
  opts: { ttlMs?: number; now?: () => number } = {},
): OAuthFlowStore {
  const ttl = opts.ttlMs ?? OAUTH_FLOW_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  return {
    async start(state, now) {
      const flowId = randomBytes(32).toString("base64url");
      await backing.put(flowId, { ...state, issuedAt: now ?? clock(), nonce: flowId });
      return flowId;
    },
    async finish(flowId, now) {
      const rec = await backing.take(flowId).catch(() => null);
      if (!rec) return null;
      if ((now ?? clock()) - rec.issuedAt > ttl) return null;
      return rec;
    },
  };
}
