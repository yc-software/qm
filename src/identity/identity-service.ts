import type { ActorAssertion, Principal } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { canonicalPerson, foldPrincipalId, personIds, personKey } from "../directory/person.ts";
import { externalMemberActive, type ExternalMember } from "./external-members.ts";
import { perTenant } from "../tenants/context.ts";

interface IdentityProvider {
  resolve(actor: ActorAssertion): Principal;
  classify(externalId: string, isExternalGuest?: boolean): Principal;
}

type DeactivationSource = "manual" | "directory-sync";

export interface DeactivationRecord {
  principalId: string;
  source: DeactivationSource;
  at: number;
}

interface DirectorySyncOutcome {
  deactivated: string[];
  reactivated: string[];
}

export interface IdentityService extends IdentityProvider {
  isInternal(p: Principal): boolean;
  audienceIsAllInternal(audience: Principal[]): boolean;
  deactivate(externalId: string, source?: DeactivationSource): Promise<void>;
  deactivationSource(externalId: string): DeactivationSource | undefined;
  reactivate(externalId: string): Promise<void>;
  recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome>;
  listExternalMembers(): Promise<ExternalMember[]>;
  externalMember(principalId: string): ExternalMember | undefined;
  putExternalMember(m: ExternalMember): Promise<void>;
  removeExternalMember(principalId: string): Promise<void>;
  hydrate(): Promise<void>;
  refresh(force?: boolean): Promise<void>;
}

export function actorAssertionActive(
  identity: Pick<IdentityService, "classify" | "isInternal">,
  actor: ActorAssertion | undefined,
): boolean {
  return !!actor?.externalId && identity.isInternal(identity.classify(actor.externalId, actor.isExternalGuest));
}

export function createIdentityService(
  backing?: DurableMap<DeactivationRecord>,
  opts: {
    directorySyncProtected?: readonly string[];
    externalMembers?: DurableMap<ExternalMember>;
    principalLinks?: { refresh(force?: boolean): Promise<void> };
  } = {},
): IdentityService {
  const store = backing ?? createMemoryMap<DeactivationRecord>();
  const externalStore = opts.externalMembers ?? createMemoryMap<ExternalMember>();
  const roster = perTenant(() => ({
    deactivated: new Map<string, DeactivationRecord>(),
    externals: new Map<string, ExternalMember>(),
    refreshedAt: 0,
    refreshP: null as Promise<void> | null,
    hydrateP: null as Promise<void> | null,
  }));
  const directorySyncProtected = opts.directorySyncProtected ?? [];
  const REFRESH_TTL_MS = 10_000;

  const keptByDirectorySync = (key: string): boolean =>
    directorySyncProtected.some((id) => personKey(id) === key) || roster().externals.has(key);
  const storeKeys = (externalId: string): string[] => personIds(externalId).map(foldPrincipalId).filter(Boolean);

  async function load(overwrite: boolean): Promise<void> {
    const { deactivated, externals } = roster();
    await opts.principalLinks?.refresh(true);
    const [deactivations, members] = await Promise.all([store.all(), externalStore.all()]);
    if (overwrite) {
      deactivated.clear();
      externals.clear();
    }
    for (const r of deactivations) {
      const key = personKey(r.principalId);
      if (deactivated.get(key)?.source !== "manual" && (r.source === "manual" || overwrite || !deactivated.has(key)))
        deactivated.set(key, r);
    }
    for (const m of members) {
      const key = personKey(m.email);
      if (overwrite || !externals.has(key)) externals.set(key, m);
    }
  }

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const id = canonicalPerson(externalId);
    const key = personKey(externalId);
    const record = roster().deactivated.get(key);
    const external = roster().externals.get(key);
    const inactive =
      record?.source === "manual" ||
      (record?.source === "directory-sync" && !keptByDirectorySync(key)) ||
      (external !== undefined && !externalMemberActive(external));
    const type: Principal["type"] = inactive || isExternalGuest ? "guest" : "internal";
    return { id, type };
  }

  async function deactivate(externalId: string, source: DeactivationSource = "manual"): Promise<void> {
    const key = personKey(externalId);
    const existing = roster().deactivated.get(key);
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId: externalId, source, at: Date.now() };
    roster().deactivated.set(key, record);
    await store.put(foldPrincipalId(externalId), record);
  }

  async function reactivate(externalId: string): Promise<void> {
    roster().deactivated.delete(personKey(externalId));
    for (const key of storeKeys(externalId)) await store.delete(key);
  }

  async function refresh(force = false): Promise<void> {
    const state = roster();
    if (state.refreshP) return state.refreshP;
    if (!force && Date.now() - state.refreshedAt < REFRESH_TTL_MS) return;
    state.refreshP = load(true)
      .then(() => {
        state.refreshedAt = Date.now();
      })
      .finally(() => {
        state.refreshP = null;
      });
    return state.refreshP;
  }

  return {
    classify,
    deactivate,
    deactivationSource(externalId: string): DeactivationSource | undefined {
      return roster().deactivated.get(personKey(externalId))?.source;
    },
    reactivate,
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      for (const id of removedIds) {
        if (keptByDirectorySync(personKey(id)) || roster().deactivated.has(personKey(id))) continue;
        await deactivate(id, "directory-sync");
        outcome.deactivated.push(id);
      }
      for (const id of presentIds) {
        if (roster().deactivated.get(personKey(id))?.source !== "directory-sync") continue;
        await reactivate(id);
        outcome.reactivated.push(id);
      }
      return outcome;
    },
    async listExternalMembers(): Promise<ExternalMember[]> {
      await refresh();
      return [...roster().externals.values()];
    },
    externalMember(principalId: string): ExternalMember | undefined {
      return roster().externals.get(personKey(principalId));
    },
    async putExternalMember(m: ExternalMember): Promise<void> {
      roster().externals.set(personKey(m.email), m);
      await externalStore.put(foldPrincipalId(m.email), m);
    },
    async removeExternalMember(principalId: string): Promise<void> {
      roster().externals.delete(personKey(principalId));
      for (const key of storeKeys(principalId)) await externalStore.delete(key);
    },
    hydrate(): Promise<void> {
      const state = roster();
      state.hydrateP ??= load(false);
      return state.hydrateP;
    },
    refresh,
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
