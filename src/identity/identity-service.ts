import { reportFailure } from "../util/errors.ts";
import type { ActorAssertion, Principal } from "../types.ts";
import { createKeyedQueue, createTtlRefresh } from "../util/async.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { canonicalPerson, foldPrincipalId, personIds, personKey } from "../directory/person.ts";
import { externalMemberActive, isTeammate, type ExternalMember } from "./external-members.ts";

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

export interface OffboardedChange {
  kind: string;
  id: string;
  label: string;
  scopeId: string;
  action: string;
  result: "done" | "failed";
  error?: string;
}

export type PrincipalSummary = Omit<PrincipalRecord, "offboardChanges">;

export type PrincipalSource = "turn" | "invite" | "admin";

export interface SeenPerson {
  principalId: string;
  source: PrincipalSource;
  at: number;
}

export interface PrincipalRecord {
  principalId: string;
  firstSeenAt?: number;
  source?: PrincipalSource;
  offboarded: boolean;
  offboardedAt?: number;
  offboardedBy?: string;
  offboardChanges?: OffboardedChange[];
  reactivatedAt?: number;
  reactivatedBy?: string;
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
  reactivate(externalId: string, by?: string): Promise<void>;
  deactivated(externalId: string): boolean;
  knows(externalId: string): boolean;
  offboarded(externalId: string): boolean;
  principal(externalId: string): Promise<PrincipalRecord | null>;
  listPrincipals(): Promise<PrincipalSummary[]>;
  notePerson(externalId: string, source: PrincipalSource): Promise<void>;
  recordPeople(people: readonly SeenPerson[]): Promise<number>;
  recordOffboarded(externalId: string, by: string, changes: OffboardedChange[]): Promise<PrincipalRecord>;
  recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome>;
  listExternalMembers(): Promise<ExternalMember[]>;
  externalMember(principalId: string): ExternalMember | undefined;
  putExternalMember(m: ExternalMember): Promise<void>;
  removeExternalMember(principalId: string): Promise<void>;
  refresh(force?: boolean): Promise<void>;
}

function mergeSummaries(a: PrincipalSummary, b: PrincipalSummary): PrincipalSummary {
  const [primary, other] = foldPrincipalId(b.principalId) === personKey(b.principalId) ? [b, a] : [a, b];
  const firstSeen = [a, b]
    .filter((r) => r.firstSeenAt !== undefined)
    .sort((x, y) => x.firstSeenAt! - y.firstSeenAt!)[0];
  return {
    ...other,
    ...primary,
    offboarded: a.offboarded || b.offboarded,
    ...(firstSeen ? { firstSeenAt: firstSeen.firstSeenAt, source: firstSeen.source } : {}),
  };
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
    principals: DurableMap<PrincipalRecord>;
    principalLinks?: { refresh(force?: boolean): Promise<void> };
  },
): IdentityService {
  const externalStore = opts.externalMembers;
  const deactivated = new Map<string, DeactivationRecord>();
  const externals = new Map<string, ExternalMember>();
  const principalStore = opts.principals;
  const principals = new Map<string, PrincipalSummary>();
  const directorySyncProtected = opts.directorySyncProtected ?? [];

  const keptByDirectorySync = (key: string): boolean =>
    directorySyncProtected.some((id) => personKey(id) === key) || externals.has(key);
  const storeKeys = (externalId: string): string[] => personIds(externalId).map(foldPrincipalId).filter(Boolean);

  const queue = createKeyedQueue();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => queue("identity", fn);

  const refresh = createTtlRefresh(10_000, () =>
    exclusive(async () => {
      await opts.principalLinks?.refresh(true);
      const [deactivations, members, records] = await Promise.all([
        store.all(),
        externalStore.all(),
        principalStore.select({ omit: ["offboardChanges"] }),
      ]);
      deactivated.clear();
      externals.clear();
      principals.clear();
      for (const r of records) {
        const key = personKey(r.principalId);
        const other = principals.get(key);
        principals.set(key, other ? mergeSummaries(other, r) : r);
      }
      for (const r of deactivations) {
        const key = personKey(r.principalId);
        if (deactivated.get(key)?.source !== "manual") deactivated.set(key, r);
      }
      for (const m of members) externals.set(personKey(m.email), m);
    }),
  );

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const id = canonicalPerson(externalId);
    const key = personKey(externalId);
    const external = externals.get(key);
    const inactive = deactivatedNow(externalId) || (external !== undefined && !externalMemberActive(external));
    const type: Principal["type"] = inactive || isExternalGuest ? "guest" : "internal";
    return { id, type };
  }

  async function deactivateNow(externalId: string, source: DeactivationSource): Promise<void> {
    const key = personKey(externalId);
    const existing = deactivated.get(key);
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId: externalId, source, at: Date.now() };
    deactivated.set(key, record);
    await store.put(foldPrincipalId(externalId), record);
  }

  const remember = ({ offboardChanges: _changes, ...summary }: PrincipalRecord): PrincipalRecord => {
    const key = personKey(summary.principalId);
    const other = principals.get(key);
    principals.set(
      key,
      other && foldPrincipalId(other.principalId) !== foldPrincipalId(summary.principalId)
        ? mergeSummaries(other, summary)
        : summary,
    );
    return { offboardChanges: _changes, ...summary };
  };
  const principalKey = (externalId: string): string =>
    foldPrincipalId(principals.get(personKey(externalId))?.principalId ?? externalId);

  async function recordSeen(people: readonly SeenPerson[]): Promise<number> {
    const earliest = new Map<string, SeenPerson>();
    for (const person of people) {
      const principalId = canonicalPerson(person.principalId);
      const id = principalKey(principalId);
      if (!id || principals.get(personKey(principalId))?.firstSeenAt !== undefined) continue;
      const known = earliest.get(id);
      if (!known || person.at < known.at) earliest.set(id, { ...person, principalId });
    }
    let added = 0;
    const records = await principalStore.mutateMany(
      [...earliest].map(([id, person]) => ({
        id,
        apply: (existing) => {
          if (existing?.firstSeenAt !== undefined) return existing;
          added++;
          return {
            ...existing,
            principalId: existing?.principalId ?? person.principalId,
            offboarded: existing?.offboarded ?? false,
            firstSeenAt: person.at,
            source: person.source,
          };
        },
      })),
    );
    for (const record of records) remember(record);
    return added;
  }

  async function reactivateNow(externalId: string, by?: string): Promise<void> {
    deactivated.delete(personKey(externalId));
    for (const key of storeKeys(externalId)) await store.delete(key);
    for (const key of new Set([principalKey(externalId), ...storeKeys(externalId)])) {
      const record = await principalStore.update(key, (r) =>
        r.offboarded ? { ...r, offboarded: false, reactivatedAt: Date.now(), ...(by ? { reactivatedBy: by } : {}) } : r,
      );
      if (record) remember(record);
    }
  }

  function deactivatedNow(externalId: string): boolean {
    const key = personKey(externalId);
    const record = deactivated.get(key);
    return record?.source === "manual" || (record?.source === "directory-sync" && !keptByDirectorySync(key));
  }

  return {
    classify,
    deactivate: (externalId, source = "manual") => exclusive(() => deactivateNow(externalId, source)),
    deactivationSource(externalId: string): DeactivationSource | undefined {
      return deactivated.get(personKey(externalId))?.source;
    },
    reactivate: (externalId, by) => exclusive(() => reactivateNow(externalId, by)),
    deactivated: deactivatedNow,
    knows(externalId: string): boolean {
      const key = personKey(externalId);
      return deactivated.has(key) || externals.has(key) || principals.has(key);
    },
    offboarded(externalId: string): boolean {
      return principals.get(personKey(externalId))?.offboarded === true;
    },
    async principal(externalId: string): Promise<PrincipalRecord | null> {
      for (const key of new Set([principalKey(externalId), ...storeKeys(externalId)])) {
        const record = await principalStore.get(key);
        if (record) return record;
      }
      return null;
    },
    async listPrincipals(): Promise<PrincipalSummary[]> {
      await refresh();
      return [...principals.values()];
    },
    async notePerson(externalId, source) {
      if (principals.get(personKey(externalId))?.firstSeenAt !== undefined) return;
      await exclusive(() => recordSeen([{ principalId: externalId, source, at: Date.now() }]));
    },
    recordPeople: (people) => exclusive(() => recordSeen(people)),
    recordOffboarded: (externalId, by, changes) =>
      exclusive(async () => {
        const [record] = await principalStore.mutateMany([
          {
            id: principalKey(externalId),
            apply: (existing) =>
              existing?.offboarded
                ? { ...existing, offboardChanges: [...(existing.offboardChanges ?? []), ...changes] }
                : {
                    ...existing,
                    principalId: existing?.principalId ?? externalId,
                    offboarded: true,
                    offboardedAt: Date.now(),
                    offboardedBy: by,
                    offboardChanges: [...(existing?.offboardChanges ?? []), ...changes],
                  },
          },
        ]);
        return remember(record!);
      }),
    recordDirectorySync: (removedIds, presentIds) =>
      exclusive(async () => {
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
      }),
    async listExternalMembers(): Promise<ExternalMember[]> {
      await refresh();
      return [...externals.values()];
    },
    externalMember(principalId: string): ExternalMember | undefined {
      return externals.get(personKey(principalId));
    },
    putExternalMember(m: ExternalMember): Promise<void> {
      return exclusive(async () => {
        externals.set(personKey(m.email), m);
        await externalStore.put(foldPrincipalId(m.email), m);
        if (isTeammate(m))
          await recordSeen([{ principalId: m.email, source: "invite", at: m.createdAt }]).catch((err: unknown) =>
            reportFailure("identity: record person", err),
          );
      });
    },
    removeExternalMember(principalId: string): Promise<void> {
      return exclusive(async () => {
        externals.delete(personKey(principalId));
        for (const key of storeKeys(principalId)) await externalStore.delete(key);
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
