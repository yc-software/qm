import type { ActorAssertion, Principal } from "../types.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { canonicalPerson, foldPrincipalId, personIds, personKey } from "../directory/person.ts";
import { externalMemberActive, type ExternalMember } from "./external-members.ts";
import { perTenant } from "../tenant.ts";

interface IdentityProvider {
  resolve(actor: ActorAssertion): Principal;
  classify(externalId: string, isExternalGuest?: boolean): Principal;
}

type DeactivationSource = "manual" | "directory-sync";

interface DeactivationRecord {
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

const DEACTIVATED_PRINCIPALS: TableSpec = {
  table: "deactivated_principals",
  key: "id",
  columns: cols(`principalId text!, source text!, at bigint!`),
};

const EXTERNAL_MEMBERS: TableSpec = {
  table: "external_members",
  key: "id",
  columns: cols(`email text!, role text!, expiresAt bigint, kind text, inviteId text, invitedBy text!,
    createdAt bigint!, updatedAt bigint!`),
};

const DEACTIVATED_PRINCIPALS_MIGRATION = mapToTableMigration(
  "identity/deactivated-principals/0001-typed",
  DEACTIVATED_PRINCIPALS,
);
const EXTERNAL_MEMBERS_MIGRATION = mapToTableMigration("identity/external-members/0001-typed", EXTERNAL_MEMBERS);

export function actorAssertionActive(
  identity: Pick<IdentityService, "classify" | "isInternal">,
  actor: ActorAssertion | undefined,
): boolean {
  return !!actor?.externalId && identity.isInternal(identity.classify(actor.externalId, actor.isExternalGuest));
}

export function createIdentityService(
  databaseUrl: string,
  opts: {
    directorySyncProtected?: () => readonly string[] | undefined;
    principalLinks?: { refresh(force?: boolean): Promise<void> };
  } = {},
): IdentityService {
  const db = createPgPool(databaseUrl, [DEACTIVATED_PRINCIPALS_MIGRATION, EXTERNAL_MEMBERS_MIGRATION]);
  const deactivations = typedTable<DeactivationRecord>(db, DEACTIVATED_PRINCIPALS);
  const members = typedTable<ExternalMember>(db, EXTERNAL_MEMBERS);
  const state = perTenant(() => ({
    deactivated: new Map<string, DeactivationRecord>(),
    externals: new Map<string, ExternalMember>(),
    refreshedAt: 0,
    refreshP: null as Promise<void> | null,
    hydrateP: null as Promise<void> | null,
  }));
  const directorySyncProtected = () => opts.directorySyncProtected?.() ?? [];
  const REFRESH_TTL_MS = 10_000;

  const keptByDirectorySync = (key: string): boolean =>
    directorySyncProtected().some((id) => personKey(id) === key) || state().externals.has(key);
  const storeKeys = (externalId: string): string[] => personIds(externalId).map(foldPrincipalId).filter(Boolean);

  async function load(overwrite: boolean): Promise<void> {
    const { deactivated, externals } = state();
    await opts.principalLinks?.refresh(true);
    const [storedDeactivations, storedMembers] = await Promise.all([deactivations.all(), members.all()]);
    if (overwrite) {
      deactivated.clear();
      externals.clear();
    }
    for (const r of storedDeactivations) {
      const key = personKey(r.principalId);
      if (deactivated.get(key)?.source !== "manual" && (r.source === "manual" || overwrite || !deactivated.has(key)))
        deactivated.set(key, r);
    }
    for (const m of storedMembers) {
      const key = personKey(m.email);
      if (overwrite || !externals.has(key)) externals.set(key, { ...m, expiresAt: m.expiresAt ?? null });
    }
  }

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const id = canonicalPerson(externalId);
    const key = personKey(externalId);
    const record = state().deactivated.get(key);
    const external = state().externals.get(key);
    const inactive =
      record?.source === "manual" ||
      (record?.source === "directory-sync" && !keptByDirectorySync(key)) ||
      (external !== undefined && !externalMemberActive(external));
    const type: Principal["type"] = inactive || isExternalGuest ? "guest" : "internal";
    return { id, type };
  }

  async function deactivate(externalId: string, source: DeactivationSource = "manual"): Promise<void> {
    const { deactivated } = state();
    const key = personKey(externalId);
    const existing = deactivated.get(key);
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId: externalId, source, at: Date.now() };
    await deactivations.put(foldPrincipalId(externalId), record);
    deactivated.set(key, record);
  }

  async function reactivate(externalId: string): Promise<void> {
    await db.q(`DELETE FROM deactivated_principals WHERE id = ANY($1::text[])`, [storeKeys(externalId)]);
    state().deactivated.delete(personKey(externalId));
  }

  async function refresh(force = false): Promise<void> {
    const s = state();
    const now = Date.now();
    if (s.refreshP) return s.refreshP;
    if (!force && now - s.refreshedAt < REFRESH_TTL_MS) return;
    s.refreshP = load(true)
      .then(() => {
        s.refreshedAt = Date.now();
      })
      .finally(() => {
        s.refreshP = null;
      });
    return s.refreshP;
  }

  return {
    classify,
    deactivate,
    deactivationSource(externalId: string): DeactivationSource | undefined {
      return state().deactivated.get(personKey(externalId))?.source;
    },
    reactivate,
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      const { deactivated } = state();
      for (const id of removedIds) {
        if (keptByDirectorySync(personKey(id)) || deactivated.has(personKey(id))) continue;
        await deactivate(id, "directory-sync");
        outcome.deactivated.push(id);
      }
      for (const id of presentIds) {
        if (deactivated.get(personKey(id))?.source !== "directory-sync") continue;
        await reactivate(id);
        outcome.reactivated.push(id);
      }
      return outcome;
    },
    async listExternalMembers(): Promise<ExternalMember[]> {
      await refresh();
      return [...state().externals.values()];
    },
    externalMember(principalId: string): ExternalMember | undefined {
      return state().externals.get(personKey(principalId));
    },
    async putExternalMember(m: ExternalMember): Promise<void> {
      state().externals.set(personKey(m.email), m);
      await members.put(foldPrincipalId(m.email), m);
    },
    async removeExternalMember(principalId: string): Promise<void> {
      state().externals.delete(personKey(principalId));
      await db.q(`DELETE FROM external_members WHERE id = ANY($1::text[])`, [storeKeys(principalId)]);
    },
    hydrate(): Promise<void> {
      const s = state();
      s.hydrateP ??= load(false).catch((error: unknown) => {
        s.hydrateP = null;
        throw error;
      });
      return s.hydrateP;
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
