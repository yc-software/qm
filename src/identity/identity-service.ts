import type { ActorAssertion, Principal } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { normalizeHandle } from "../directory/person.ts";
import { externalMemberActive, type ExternalMember } from "./external-members.ts";
import { createPrincipalGraph, isPrincipalId, type PrincipalGraph } from "./principals.ts";

type DeactivationSource = "manual" | "directory-sync";

/** Deactivation is a property of a principal; records are keyed by its UUID. */
export interface DeactivationRecord {
  principalId: string;
  source: DeactivationSource;
  at: number;
}

interface DirectorySyncOutcome {
  deactivated: string[];
  reactivated: string[];
}

export interface IdentityService {
  /** The principal graph handles resolve through. One per deployment. */
  readonly principals: PrincipalGraph;
  /** Edge entry point: the asserted handle acted, so resolve it to its principal (creating one) and classify it. */
  actor(actor: ActorAssertion): Promise<Principal>;
  /** Classify an id the edge already resolved. Handles resolve through the in-memory identity index. */
  classify(id: string, isExternalGuest?: boolean): Principal;
  isInternal(p: Principal): boolean;
  audienceIsAllInternal(audience: Principal[]): boolean;
  deactivate(id: string, source?: DeactivationSource): Promise<void>;
  deactivationSource(id: string): DeactivationSource | undefined;
  reactivate(id: string): Promise<void>;
  recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome>;
  listExternalMembers(): Promise<ExternalMember[]>;
  externalMember(id: string): ExternalMember | undefined;
  putExternalMember(m: ExternalMember): Promise<void>;
  removeExternalMember(email: string): Promise<void>;
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
    isOverridden?: (handle: string) => boolean;
    directorySyncProtected?: readonly string[];
    externalMembers?: DurableMap<ExternalMember>;
    principals?: PrincipalGraph;
  } = {},
): IdentityService {
  const store = backing ?? createMemoryMap<DeactivationRecord>();
  const externalStore = opts.externalMembers ?? createMemoryMap<ExternalMember>();
  const graph = opts.principals ?? createPrincipalGraph();
  const deactivated = new Map<string, DeactivationRecord>();
  const externals = new Map<string, ExternalMember>();
  const directorySyncProtected = opts.directorySyncProtected ?? [];
  const REFRESH_TTL_MS = 10_000;
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  /** The principal an id names: a UUID is itself, a handle goes through its identity. */
  const principalKey = (id: string): string | undefined =>
    isPrincipalId(id.trim()) ? id.trim().toLowerCase() : graph.principalOf(id);
  const principalHandles = (principalId: string): string[] => [principalId, ...graph.handlesOf(principalId)];
  const resolve = async (id: string): Promise<string> => principalKey(id) ?? graph.act(id);
  const emailKey = (email: string): string => normalizeHandle(email);
  const externalFor = (id: string): ExternalMember | undefined => {
    const principal = principalKey(id);
    if (!principal) return externals.get(emailKey(id));
    for (const handle of principalHandles(principal)) {
      const m = externals.get(emailKey(handle));
      if (m) return m;
    }
    return undefined;
  };
  const overridden = (id: string): boolean => {
    if (!opts.isOverridden) return false;
    const principal = principalKey(id);
    return (principal ? principalHandles(principal) : [id]).some((h) => opts.isOverridden!(h));
  };
  const keptByDirectorySync = (id: string): boolean => {
    const principal = principalKey(id);
    return (
      (!!principal && directorySyncProtected.some((h) => principalKey(h) === principal)) ||
      externalFor(id) !== undefined
    );
  };

  async function load(overwrite: boolean): Promise<void> {
    await graph.refresh(true);
    const [deactivations, members] = await Promise.all([store.all(), externalStore.all()]);
    if (overwrite) {
      deactivated.clear();
      externals.clear();
    }
    for (const r of deactivations) if (overwrite || !deactivated.has(r.principalId)) deactivated.set(r.principalId, r);
    for (const m of members) if (overwrite || !externals.has(emailKey(m.email))) externals.set(emailKey(m.email), m);
  }

  function classify(id: string, isExternalGuest?: boolean): Principal {
    const principal = principalKey(id);
    const pid = principal ?? id;
    if (overridden(id)) return { id: pid, type: "internal" };
    const record = principal ? deactivated.get(principal) : undefined;
    const external = externalFor(id);
    const inactive =
      record?.source === "manual" ||
      (record?.source === "directory-sync" && !keptByDirectorySync(id)) ||
      (external !== undefined && !externalMemberActive(external));
    return { id: pid, type: inactive || isExternalGuest ? "guest" : "internal" };
  }

  async function deactivate(id: string, source: DeactivationSource = "manual"): Promise<void> {
    const principalId = await resolve(id);
    const existing = deactivated.get(principalId);
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId, source, at: Date.now() };
    deactivated.set(principalId, record);
    await store.put(principalId, record);
  }

  async function reactivate(id: string): Promise<void> {
    const principalId = principalKey(id);
    if (!principalId) return;
    deactivated.delete(principalId);
    await store.delete(principalId);
  }

  async function refresh(force = false): Promise<void> {
    const now = Date.now();
    if (refreshP) return refreshP;
    if (!force && now - refreshedAt < REFRESH_TTL_MS) return;
    refreshP = load(true)
      .then(() => {
        refreshedAt = Date.now();
      })
      .finally(() => {
        refreshP = null;
      });
    return refreshP;
  }

  return {
    principals: graph,
    async actor(actor: ActorAssertion): Promise<Principal> {
      const principalId = actor.isExternalGuest
        ? actor.externalId
        : await graph.act(actor.externalId, {
            kind: actor.isBot ? "agent" : "person",
            ...(actor.displayName ? { displayName: actor.displayName } : {}),
          });
      const p = classify(principalId, actor.isExternalGuest);
      return {
        ...p,
        ...(actor.teamIds ? { teamIds: actor.teamIds } : {}),
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
      };
    },
    classify,
    deactivate,
    deactivationSource(id: string): DeactivationSource | undefined {
      const principal = principalKey(id);
      return principal ? deactivated.get(principal)?.source : undefined;
    },
    reactivate,
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      for (const id of removedIds) {
        const principal = principalKey(id);
        if (keptByDirectorySync(id) || (principal && deactivated.has(principal))) continue;
        await deactivate(id, "directory-sync");
        outcome.deactivated.push(id);
      }
      for (const id of presentIds) {
        const principal = principalKey(id);
        if (!principal || deactivated.get(principal)?.source !== "directory-sync") continue;
        await reactivate(id);
        outcome.reactivated.push(id);
      }
      return outcome;
    },
    async listExternalMembers(): Promise<ExternalMember[]> {
      await refresh();
      return [...externals.values()];
    },
    externalMember(id: string): ExternalMember | undefined {
      return externalFor(id);
    },
    async putExternalMember(m: ExternalMember): Promise<void> {
      externals.set(emailKey(m.email), m);
      await externalStore.put(emailKey(m.email), m);
    },
    async removeExternalMember(email: string): Promise<void> {
      externals.delete(emailKey(email));
      await externalStore.delete(emailKey(email));
    },
    hydrate(): Promise<void> {
      if (!hydrateP) hydrateP = load(false);
      return hydrateP;
    },
    refresh,
    isInternal(p: Principal): boolean {
      return p.type === "internal";
    },
    audienceIsAllInternal(audience: Principal[]): boolean {
      return audience.length > 0 && audience.every((p) => p.type === "internal");
    },
  };
}

type AssertedRequest = {
  actor: ActorAssertion;
  conversation: { audience?: ActorAssertion[]; publishMembers?: ActorAssertion[] };
};

/** A surface request with every asserted handle replaced by its principal UUID. Runs once, where the request enters core. */
export async function principalRequest<R extends AssertedRequest>(
  identity: Pick<IdentityService, "principals">,
  req: R,
): Promise<R> {
  const one = async (a: ActorAssertion): Promise<ActorAssertion> =>
    a.isExternalGuest
      ? a
      : {
          ...a,
          externalId: await identity.principals.act(a.externalId, {
            kind: a.isBot ? "agent" : "person",
            ...(a.displayName ? { displayName: a.displayName } : {}),
          }),
        };
  const many = async (list: ActorAssertion[] | undefined) => (list ? Promise.all(list.map(one)) : undefined);
  const [actor, audience, publishMembers] = await Promise.all([
    one(req.actor),
    many(req.conversation.audience),
    many(req.conversation.publishMembers),
  ]);
  return {
    ...req,
    actor,
    conversation: {
      ...req.conversation,
      ...(audience ? { audience } : {}),
      ...(publishMembers ? { publishMembers } : {}),
    },
  };
}
