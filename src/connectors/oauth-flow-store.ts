import { randomBytes } from "node:crypto";
import type { OneTimeRows } from "./link-tables.ts";
import type { OAuthState } from "./oauth.ts";
import { swallowAs } from "../util/errors.ts";
import { currentTenant } from "../tenants/context.ts";

export interface OAuthFlowStore {
  start(state: Omit<OAuthState, "issuedAt" | "nonce">, now?: number): Promise<string>;
  finish(flowId: string, now?: number): Promise<OAuthState | null>;
}

const OAUTH_FLOW_TTL_MS = 10 * 60_000;

type OAuthFlow = Omit<OAuthState, "tenant">;

export function createOAuthFlowStore(
  backing: OneTimeRows<OAuthFlow>,
  opts: { ttlMs?: number; now?: () => number } = {},
): OAuthFlowStore {
  const ttl = opts.ttlMs ?? OAUTH_FLOW_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  return {
    async start(state, now) {
      const { tenant, ...flow } = state as typeof state & { tenant?: string };
      if (tenant !== undefined && tenant !== currentTenant()) throw new Error("OAuth state is for a different tenant");
      const flowId = randomBytes(32).toString("base64url");
      await backing.insert(flowId, { ...flow, issuedAt: now ?? clock(), nonce: flowId });
      return flowId;
    },
    async finish(flowId, now) {
      const rec = await backing.take(flowId).catch(swallowAs("oauth flow: take state", null));
      if (!rec) return null;
      if ((now ?? clock()) - rec.issuedAt > ttl) return null;
      return { ...rec, tenant: currentTenant() } as OAuthState;
    },
  };
}
