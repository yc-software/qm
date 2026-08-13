import { randomBytes } from "node:crypto";
import { verifySignedPayload } from "../auth/signed-token.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AccountType } from "./oauth.ts";

export interface OAuthFlowContext {
  provider: string;
  principalId: string;
  redirectUri: string;
  createdAt: number;
  returnTo?: string;
  orgId?: string;
  accountType?: AccountType;
  clientRef?: string;
  clientId?: string;
  codeVerifier?: string;
  consentLinkId?: string;
}

type OAuthFlowRedeemResult = { ok: true; context: OAuthFlowContext } | { ok: false; reason: "not_found" | "expired" };

export interface OAuthFlowStore {
  mint(context: Omit<OAuthFlowContext, "createdAt">, now?: number): Promise<{ state: string }>;
  redeem(state: string, now?: number): Promise<OAuthFlowRedeemResult>;
  sweep(now?: number): Promise<void>;
}

export const OAUTH_FLOW_TTL_MS = 10 * 60_000;

export interface LegacyOAuthState extends Omit<OAuthFlowContext, "createdAt"> {
  issuedAt: number;
  nonce: string;
}

const ACCOUNT_TYPES: readonly AccountType[] = ["default", "personal", "company"];

function isLegacyOAuthState(value: unknown): value is LegacyOAuthState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as LegacyOAuthState;
  return (
    typeof state.provider === "string" &&
    typeof state.principalId === "string" &&
    typeof state.redirectUri === "string" &&
    typeof state.issuedAt === "number" &&
    typeof state.nonce === "string" &&
    (state.returnTo === undefined || typeof state.returnTo === "string") &&
    (state.orgId === undefined || typeof state.orgId === "string") &&
    (state.accountType === undefined || ACCOUNT_TYPES.includes(state.accountType)) &&
    (state.clientRef === undefined || typeof state.clientRef === "string") &&
    (state.clientId === undefined || typeof state.clientId === "string") &&
    (state.codeVerifier === undefined || typeof state.codeVerifier === "string") &&
    (state.consentLinkId === undefined || typeof state.consentLinkId === "string")
  );
}

export async function openLegacyOAuthState(
  sealed: string,
  secret: string,
  now: number = Date.now(),
): Promise<LegacyOAuthState> {
  const state = await verifySignedPayload(sealed, secret);
  if (!isLegacyOAuthState(state)) throw new Error("invalid OAuth state");
  if (state.issuedAt > now + 60_000 || now - state.issuedAt > OAUTH_FLOW_TTL_MS) {
    throw new Error("expired OAuth state");
  }
  return state;
}

export function createOAuthFlowStore(
  backing: DurableMap<OAuthFlowContext>,
  opts: { ttlMs?: number; now?: () => number } = {},
): OAuthFlowStore {
  if (!backing.deleteIf) throw new Error("OAuth flow store requires atomic conditional deletion");
  const deleteIf = backing.deleteIf;
  const ttlMs = opts.ttlMs ?? OAUTH_FLOW_TTL_MS;
  const clock = opts.now ?? Date.now;
  return {
    async mint(context, now) {
      const state = randomBytes(32).toString("base64url");
      await backing.put(state, { ...context, createdAt: now ?? clock() });
      return { state };
    },
    async redeem(state, now) {
      const context = await backing.take(state);
      if (!context) return { ok: false, reason: "not_found" };
      if ((now ?? clock()) - context.createdAt > ttlMs) return { ok: false, reason: "expired" };
      return { ok: true, context };
    },
    async sweep(now) {
      const cutoff = (now ?? clock()) - ttlMs;
      for (const [state, context] of await backing.entries()) {
        if (context.createdAt < cutoff) {
          await deleteIf(state, (current) => current.createdAt < cutoff);
        }
      }
    },
  };
}
