import type { ActorAssertion, Principal } from "../types.ts";
import { createKeyedQueue, createTtlRefresh } from "../util/async.ts";
import { createPgPool } from "../persistence/pg-pool.ts";
import { typedTableMigration } from "../persistence/typed-table-migration.ts";
import { TENANCY_BASE, TENANT } from "../tenants/migrations.ts";
import { currentTenant, perTenant } from "../tenants/context.ts";
import { canonicalPerson, foldPrincipalId, personIds, personKey } from "../directory/person.ts";
import { externalMemberActive, type ExternalMember, type ExternalMemberStore } from "./external-members.ts";

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

export interface DeactivationStore {
  list(): Promise<DeactivationRecord[]>;
  put(record: DeactivationRecord): Promise<void>;
  remove(principalIds: readonly string[]): Promise<void>;
  close?(): Promise<void>;
}

const DEACTIVATED_PRINCIPALS_MIGRATION = typedTableMigration({
  table: "deactivated_principals",
  columns: ["principal_id TEXT NOT NULL", "source TEXT NOT NULL", "at BIGINT NOT NULL"],
  constraints: ["CHECK (source IN ('manual', 'directory-sync'))"],
  primaryKey: ["principal_id"],
  backfill: { principal_id: "id", source: "json->>'source'", at: "round((json->>'at')::numeric)::bigint" },
  where: "json->>'source' IN ('manual', 'directory-sync') AND json->>'at' IS NOT NULL",
});

export function createPostgresDeactivationStore(connectionString: string): DeactivationStore {
  const { q, close } = createPgPool(connectionString, [TENANCY_BASE, DEACTIVATED_PRINCIPALS_MIGRATION]);
  return {
    async list() {
      const rows = await q(
        `SELECT principal_id, source, at FROM deactivated_principals WHERE tenant_id = ${TENANT} ORDER BY principal_id`,
      );
      return rows.map((row) => ({
        principalId: String(row.principal_id),
        source: row.source as DeactivationSource,
        at: Number(row.at),
      }));
    },
    async put(record) {
      await q(
        `INSERT INTO deactivated_principals(principal_id, source, at) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, principal_id) DO UPDATE SET source = EXCLUDED.source, at = EXCLUDED.at`,
        [foldPrincipalId(record.principalId), record.source, record.at],
      );
    },
    async remove(principalIds) {
      await q(`DELETE FROM deactivated_principals WHERE tenant_id = ${TENANT} AND principal_id = ANY($1)`, [
        principalIds.map(foldPrincipalId),
      ]);
    },
    close,
  };
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
  ready(): Promise<void>;
}

export function actorAssertionActive(
  identity: Pick<IdentityService, "classify" | "isInternal">,
  actor: ActorAssertion | undefined,
): boolean {
  return !!actor?.externalId && identity.isInternal(identity.classify(actor.externalId, actor.isExternalGuest));
}

export function createIdentityService(
  store: DeactivationStore,
  opts: {
    directorySyncProtected?: () => Promise<readonly string[]>;
    externalMembers: ExternalMemberStore;
    principalLinks?: { refresh(force?: boolean): Promise<void> };
  },
): IdentityService {
  const externalStore = opts.externalMembers;
  const queue = createKeyedQueue();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => queue(currentTenant(), fn);

  const roster = perTenant(() => {
    const state = {
      deactivated: new Map<string, DeactivationRecord>(),
      externals: new Map<string, ExternalMember>(),
      kept: [] as readonly string[],
      loaded: false,
      firstLoad: null as Promise<void> | null,
      refresh: createTtlRefresh(10_000, () =>
        exclusive(async () => {
          await opts.principalLinks?.refresh(true);
          const [deactivations, members, kept] = await Promise.all([
            store.list(),
            externalStore.list(),
            opts.directorySyncProtected?.() ?? [],
          ]);
          state.kept = kept;
          state.deactivated.clear();
          state.externals.clear();
          for (const r of deactivations) {
            const key = personKey(r.principalId);
            if (state.deactivated.get(key)?.source !== "manual") state.deactivated.set(key, r);
          }
          for (const m of members) state.externals.set(personKey(m.email), m);
          state.loaded = true;
        }),
      ),
    };
    return state;
  });
  const refresh = (force?: boolean): Promise<void> => roster().refresh(force);
  const loadedRoster = () => {
    const state = roster();
    if (!state.loaded) throw new Error("The identity roster for this tenant has not loaded");
    return state;
  };

  const keptByDirectorySync = (key: string): boolean =>
    roster().kept.some((id) => personKey(id) === key) || roster().externals.has(key);
  const storeKeys = (externalId: string): string[] => personIds(externalId).map(foldPrincipalId).filter(Boolean);

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const id = canonicalPerson(externalId);
    const key = personKey(externalId);
    const { deactivated, externals } = loadedRoster();
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
    deactivated.set(key, record);
    await store.put(record);
  }

  async function reactivateNow(externalId: string): Promise<void> {
    roster().deactivated.delete(personKey(externalId));
    await store.remove(storeKeys(externalId));
  }

  return {
    classify,
    deactivate: (externalId, source = "manual") => exclusive(() => deactivateNow(externalId, source)),
    deactivationSource(externalId: string): DeactivationSource | undefined {
      return loadedRoster().deactivated.get(personKey(externalId))?.source;
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
      return loadedRoster().externals.get(personKey(principalId));
    },
    putExternalMember(m: ExternalMember): Promise<void> {
      return exclusive(async () => {
        roster().externals.set(personKey(m.email), m);
        await externalStore.put(m);
      });
    },
    removeExternalMember(principalId: string): Promise<void> {
      return exclusive(async () => {
        roster().externals.delete(personKey(principalId));
        await externalStore.remove(storeKeys(principalId));
      });
    },
    refresh,
    ready(): Promise<void> {
      const state = roster();
      if (state.loaded) return Promise.resolve();
      state.firstLoad ??= state.refresh(true).finally(() => {
        state.firstLoad = null;
      });
      return state.firstLoad;
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
