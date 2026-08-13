import type { ActorAssertion, Principal } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { personKey } from "../directory/person.ts";

interface IdentityProvider {
  resolve(actor: ActorAssertion): Principal;
  classify(externalId: string, isExternalGuest?: boolean): Principal;
}

type DeactivationSource = "manual" | "directory-sync";

export interface DeactivationRecord {
  principalId: string;
  source: DeactivationSource;
  at: number;
  identitySource?: "directory-sync";
}

export type PortalIdentityAccess =
  { active: true; recovered: boolean } | { active: false; deactivation: DeactivationRecord };

interface DirectorySyncOutcome {
  deactivated: string[];
  reactivated: string[];
}

export interface IdentityService extends IdentityProvider {
  isInternal(p: Principal): boolean;
  audienceIsAllInternal(audience: Principal[]): boolean;
  deactivate(externalId: string, source?: DeactivationSource, identitySource?: "directory-sync"): Promise<void>;
  reactivate(externalId: string): Promise<void>;
  recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome>;
  portalIdentityAccess(externalId: string, recoverLegacy?: boolean): Promise<PortalIdentityAccess>;
  deactivation(externalId: string): DeactivationRecord | null;
  deactivations(): DeactivationRecord[];
  hydrate(): Promise<void>;
  refresh(): Promise<void>;
}

export function createIdentityService(backing?: DurableMap<DeactivationRecord>): IdentityService {
  const store = backing ?? createMemoryMap<DeactivationRecord>();
  const deactivated = new Map<string, DeactivationRecord>();
  const REFRESH_TTL_MS = 10_000;
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const type: Principal["type"] = deactivated.has(personKey(externalId)) || isExternalGuest ? "guest" : "internal";
    return { id: externalId, type };
  }

  const atomicUpdate = store.update;
  const atomicDelete = store.deleteIf;

  async function deactivateRecord(
    externalId: string,
    source: DeactivationSource = "manual",
    identitySource?: "directory-sync",
  ): Promise<boolean> {
    const key = personKey(externalId);
    const record: DeactivationRecord = {
      principalId: externalId,
      source,
      at: Date.now(),
      ...(identitySource ? { identitySource } : {}),
    };
    if (!atomicUpdate) throw new Error("deactivation store does not support atomic updates");
    for (;;) {
      const existing = await store.get(key);
      if (!existing) {
        const stored = await store.putIfAbsent(key, record);
        deactivated.set(key, stored);
        if (stored.at === record.at && stored.source === record.source) return true;
        continue;
      }
      let changed = false;
      const stored = await atomicUpdate.call(store, key, (current) => {
        if (source === "directory-sync") {
          if (current.source === "manual" || current.identitySource === "directory-sync") return current;
          changed = true;
          return { ...current, identitySource: "directory-sync" };
        }
        if (current.source === "manual") return current;
        changed = true;
        return record;
      });
      if (!stored) continue;
      deactivated.set(key, stored);
      return changed;
    }
  }

  async function deactivate(
    externalId: string,
    source: DeactivationSource = "manual",
    identitySource?: "directory-sync",
  ): Promise<void> {
    await deactivateRecord(externalId, source, identitySource);
  }

  async function reactivate(externalId: string): Promise<void> {
    const key = personKey(externalId);
    deactivated.delete(key);
    await store.delete(key);
  }

  return {
    classify,
    deactivate,
    reactivate,
    deactivation(externalId) {
      return deactivated.get(personKey(externalId)) ?? null;
    },
    deactivations() {
      return [...deactivated.values()].sort((a, b) => a.principalId.localeCompare(b.principalId));
    },
    async portalIdentityAccess(externalId, recoverLegacy = true) {
      const key = personKey(externalId);
      const record = await store.get(key);
      if (record) deactivated.set(key, record);
      else deactivated.delete(key);
      if (!record) return { active: true, recovered: false };
      if (recoverLegacy && record.source === "directory-sync" && record.identitySource !== "directory-sync") {
        if (!atomicDelete) throw new Error("deactivation store does not support conditional deletes");
        const recovered = await atomicDelete.call(
          store,
          key,
          (current) => current.source === "directory-sync" && current.identitySource !== "directory-sync",
        );
        if (recovered) {
          deactivated.delete(key);
          return { active: true, recovered: true };
        }
        const current = await store.get(key);
        if (!current) {
          deactivated.delete(key);
          return { active: true, recovered: false };
        }
        deactivated.set(key, current);
        return { active: false, deactivation: current };
      }
      return { active: false, deactivation: record };
    },
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      const removed = new Map(removedIds.map((id) => [personKey(id), id]));
      const present = new Map(presentIds.map((id) => [personKey(id), id]));
      for (const [key, id] of removed) {
        if (present.has(key)) continue;
        if (await deactivateRecord(id, "directory-sync", "directory-sync")) outcome.deactivated.push(id);
      }
      for (const [key, id] of present) {
        if (!atomicDelete) throw new Error("deactivation store does not support conditional deletes");
        const reactivated = await atomicDelete.call(store, key, (current) => current.source === "directory-sync");
        if (!reactivated) continue;
        deactivated.delete(key);
        outcome.reactivated.push(id);
      }
      return outcome;
    },
    hydrate(): Promise<void> {
      if (!hydrateP) {
        hydrateP = store.all().then((records) => {
          for (const r of records) {
            const key = personKey(r.principalId);
            if (!deactivated.has(key)) deactivated.set(key, r);
          }
        });
      }
      return hydrateP;
    },
    async refresh(): Promise<void> {
      const now = Date.now();
      if (refreshP) return refreshP;
      if (now - refreshedAt < REFRESH_TTL_MS) return;
      refreshP = store
        .all()
        .then((records) => {
          deactivated.clear();
          for (const record of records) deactivated.set(personKey(record.principalId), record);
          refreshedAt = Date.now();
        })
        .finally(() => {
          refreshP = null;
        });
      return refreshP;
    },
    resolve(actor: ActorAssertion): Principal {
      const p = classify(actor.externalId, actor.isExternalGuest);
      return {
        ...p,
        ...(actor.teamIds ? { teamIds: actor.teamIds } : {}),
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
      };
    },
    isInternal(p: Principal): boolean {
      return p.type === "internal";
    },
    audienceIsAllInternal(audience: Principal[]): boolean {
      return audience.length > 0 && audience.every((p) => p.type === "internal");
    },
  };
}
