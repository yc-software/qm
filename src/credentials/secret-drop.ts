import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { Destination, ScopeId } from "../types.ts";
import type { GrantMode } from "./keychain.ts";

export interface SecretDropField {
  key: string;
  label?: string;
  secret?: boolean;
}

export interface SecretDropRecord {
  ownerId: string;
  orgId?: string;
  service: string;
  envKey?: string;
  host?: string;
  fields?: SecretDropField[];
  purpose: string;
  requestedBy: string;
  audienceScopeId?: ScopeId;
  scopeVersion?: string;
  grantMode?: GrantMode;
  destination?: Destination;
  threadRef?: string;
  requiresToken?: boolean;
  createdAt: number;
}

type SecretDropResult = { ok: true; rec: SecretDropRecord } | { ok: false; reason: "not_found" | "expired" };

export interface SecretDropStore {
  mint(rec: Omit<SecretDropRecord, "createdAt">, now?: number): Promise<{ dropId: string }>;
  peek(dropId: string, now?: number): Promise<SecretDropResult>;
  redeem(dropId: string, now?: number): Promise<SecretDropResult>;
  siblings(rec: SecretDropRecord, now?: number): Promise<SecretDropRecord[]>;
}

export const SECRET_DROP_TTL_MS = 7 * 24 * 60 * 60_000;

export function createSecretDropStore(
  backing: DurableMap<SecretDropRecord>,
  opts: { ttlMs?: number; now?: () => number } = {},
): SecretDropStore {
  const ttl = opts.ttlMs ?? SECRET_DROP_TTL_MS;
  const clock = opts.now ?? (() => Date.now());
  const judge = (rec: SecretDropRecord | null, at: number): SecretDropResult => {
    if (!rec) return { ok: false, reason: "not_found" };
    if (at - rec.createdAt > ttl) return { ok: false, reason: "expired" };
    return { ok: true, rec };
  };
  return {
    async mint(rec, now) {
      const dropId = `${randomUUID()}${randomUUID().replace(/-/g, "")}`;
      await backing.put(dropId, { ...rec, createdAt: now ?? clock() });
      return { dropId };
    },
    async peek(dropId, now) {
      return judge(await backing.get(dropId), now ?? clock());
    },
    async redeem(dropId, now) {
      return judge(await backing.take(dropId), now ?? clock());
    },
    async siblings(rec, now) {
      const at = now ?? clock();
      const out: SecretDropRecord[] = [];
      for (const [id, r] of await backing.entries()) {
        if (at - r.createdAt > ttl) {
          void backing.delete(id).catch(() => {});
          continue;
        }
        if (
          r.orgId === rec.orgId &&
          r.audienceScopeId === rec.audienceScopeId &&
          r.threadRef === rec.threadRef &&
          r.service !== rec.service
        )
          out.push(r);
      }
      return out;
    },
  };
}
