import type { ActorAssertion, Principal } from "../types.ts";
import { createKeyedQueue, createTtlRefresh } from "../util/async.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { perTenant } from "../tenants/cache.ts";
import { currentTenant } from "../tenants/context.ts";
import { canonicalPerson, foldPrincipalId, personIds, personKey } from "../directory/person.ts";
import { externalMemberActive, type ExternalMember } from "./external-members.ts";

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
  refresh(force?: boolean): Promise<void>;
}

export function actorAssertionActive(
  identity: Pick<IdentityService, "classify" | "isInternal">,
  actor: ActorAssertion | undefined,
): boolean {
  return !!actor?.externalId && identity.isInternal(identity.classify(actor.externalId, actor.isExternalGuest));
}

export function createIdentityService(
  store: DurableMap<DeactivationRecord>,
  opts: {
    directorySyncProtected?: readonly string[];
    externalMembers: DurableMap<ExternalMember>;
    principalLinks?: { refresh(force?: boolean): Promise<void> };
  },
): IdentityService {
  const externalStore = opts.externalMembers;
  const directorySyncProtected = opts.directorySyncProtected ?? [];
  const queue = createKeyedQueue();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => queue(currentTenant(), fn);

  const roster = perTenant(() => {
    const state: {
      deactivated: Map<string, DeactivationRecord>;
      externals: Map<string, ExternalMember>;
      refresh: (force?: boolean) => Promise<void>;
    } = {
      deactivated: new Map<string, DeactivationRecord>(),
      externals: new Map<string, ExternalMember>(),
      refresh: createTtlRefresh(10_000, () =>
        exclusive(async () => {
          await opts.principalLinks?.refresh(true);
          const [deactivations, members] = await Promise.all([store.all(), externalStore.all()]);
          state.deactivated.clear();
          state.externals.clear();
          for (const r of deactivations) {
            const key = personKey(r.principalId);
            if (state.deactivated.get(key)?.source !== "manual") state.deactivated.set(key, r);
          }
          for (const m of members) state.externals.set(personKey(m.email), m);
        }),
      ),
    };
    return state;
  });
  const refresh = (force?: boolean): Promise<void> => roster().refresh(force);

  const keptByDirectorySync = (key: string): boolean =>
    directorySyncProtected.some((id) => personKey(id) === key) || roster().externals.has(key);
  const storeKeys = (externalId: string): string[] => personIds(externalId).map(foldPrincipalId).filter(Boolean);

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const id = canonicalPerson(externalId);
    const key = personKey(externalId);
    const { deactivated, externals } = roster();
    const record = deactivated.get(key);
    const external = externals.get(key);
    const inactive =
      record?.source === "manual" ||
      (record?.source === "directory-sync" && !keptByDirectorySync(key)) ||
      (external !== undefined && !externalMemberActive(external));
    const type: Principal["type"] = inactive || isExternalGuest ? "guest" : "internal";
    return { id, type };
  }

  async function deactivateNow(externalId: string, source: DeactivationSource): Promise<void> {
    const key = personKey(externalId);
    const { deactivated } = roster();
    const existing = deactivated.get(key);
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId: externalId, source, at: Date.now() };
    await store.put(foldPrincipalId(externalId), record);
    deactivated.set(key, record);
  }

  async function reactivateNow(externalId: string): Promise<void> {
    for (const key of storeKeys(externalId)) await store.delete(key);
    roster().deactivated.delete(personKey(externalId));
  }

  return {
    classify,
    deactivate: (externalId, source = "manual") => exclusive(() => deactivateNow(externalId, source)),
    deactivationSource(externalId: string): DeactivationSource | undefined {
      return roster().deactivated.get(personKey(externalId))?.source;
    },
    reactivate: (externalId) => exclusive(() => reactivateNow(externalId)),
    recordDirectorySync: async (removedIds, presentIds) => {
      await refresh();
      return exclusive(async () => {
        const { deactivated } = roster();
        const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
        for (const id of removedIds) {
          if (keptByDirectorySync(personKey(id)) || deactivated.has(personKey(id))) continue;
          await deactivateNow(id, "directory-sync");
          outcome.deactivated.push(id);
        }
        for (const id of presentIds) {
          if (deactivated.get(personKey(id))?.source !== "directory-sync") continue;
          await reactivateNow(id);
          outcome.reactivated.push(id);
        }
        return outcome;
      });
    },
    async listExternalMembers(): Promise<ExternalMember[]> {
      await refresh();
      return [...roster().externals.values()];
    },
    externalMember(principalId: string): ExternalMember | undefined {
      return roster().externals.get(personKey(principalId));
    },
    putExternalMember(m: ExternalMember): Promise<void> {
      return exclusive(async () => {
        await externalStore.put(foldPrincipalId(m.email), m);
        roster().externals.set(personKey(m.email), m);
      });
    },
    removeExternalMember(principalId: string): Promise<void> {
      return exclusive(async () => {
        for (const key of storeKeys(principalId)) await externalStore.delete(key);
        roster().externals.delete(personKey(principalId));
      });
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
