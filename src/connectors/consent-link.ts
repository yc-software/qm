import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AccountType } from "./oauth.ts";

export interface ConsentLinkRecord {
  principalId: string;
  orgId?: string;
  provider: string;
  accountType: AccountType;
  redirectUri: string;
  returnTo?: string;
  createdAt: number;
}

type ConsentRedeemResult = { ok: true; rec: ConsentLinkRecord } | { ok: false; reason: "not_found" | "expired" };

export interface ConsentLinkStore {
  mint(rec: Omit<ConsentLinkRecord, "createdAt">, now?: number): Promise<{ linkId: string }>;
  peek(linkId: string, now?: number): Promise<ConsentRedeemResult>;
  redeem(linkId: string, now?: number): Promise<ConsentRedeemResult>;
}

const CONSENT_LINK_TTL_MS = 24 * 60 * 60_000;

export function createConsentLinkStore(
  backing: DurableMap<ConsentLinkRecord>,
  opts: { ttlMs?: number; now?: () => number } = {},
): ConsentLinkStore {
  const ttl = opts.ttlMs ?? CONSENT_LINK_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  return {
    async mint(rec, now) {
      const linkId = `${randomUUID()}${randomUUID().replace(/-/g, "")}`;
      await backing.put(linkId, { ...rec, createdAt: now ?? clock() });
      return { linkId };
    },
    async peek(linkId, now) {
      const rec = await backing.get(linkId);
      if (!rec) return { ok: false, reason: "not_found" };
      if ((now ?? clock()) - rec.createdAt > ttl) return { ok: false, reason: "expired" };
      return { ok: true, rec };
    },
    async redeem(linkId, now) {
      const rec = await backing.take(linkId);
      if (!rec) return { ok: false, reason: "not_found" };
      if ((now ?? clock()) - rec.createdAt > ttl) return { ok: false, reason: "expired" };
      return { ok: true, rec };
    },
  };
}
