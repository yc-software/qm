import type { ActorAssertion, Principal } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { normalizeHandle } from "../directory/person.ts";
import { externalMemberActive, type ExternalMember } from "./external-members.ts";
import { createPrincipalGraph, type PrincipalGraph } from "./principals.ts";

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

export interface IdentityService {
  readonly principals: PrincipalGraph;
  actor(actor: ActorAssertion): Promise<Principal>;
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

  const emailKey = (email: string): string => normalizeHandle(email);
  const emailsOf = (principalId: string): string[] =>
    graph
      .identitiesOf(principalId)
      .filter((i) => i.provider === "email")
      .map((i) => i.externalId);
  const externalFor = (principalId: string): ExternalMember | undefined =>
    emailsOf(principalId)
      .map((e) => externals.get(e))
      .find(Boolean);
  const overridden = (principalId: string): boolean =>
    !!opts.isOverridden && graph.identitiesOf(principalId).some((i) => opts.isOverridden!(i.externalId));
  const keptByDirectorySync = (principalId: string): boolean =>
    directorySyncProtected.some((e) => graph.principalOf(e) === principalId) || externalFor(principalId) !== undefined;

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

  function classify(principalId: string, isExternalGuest?: boolean): Principal {
    if (overridden(principalId)) return { id: principalId, type: "internal" };
    const record = deactivated.get(principalId);
    const external = externalFor(principalId);
    const inactive =
      record?.source === "manual" ||
      (record?.source === "directory-sync" && !keptByDirectorySync(principalId)) ||
      (external !== undefined && !externalMemberActive(external));
    return { id: principalId, type: inactive || isExternalGuest ? "guest" : "internal" };
  }

  async function deactivate(principalId: string, source: DeactivationSource = "manual"): Promise<void> {
    const existing = deactivated.get(principalId);
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId, source, at: Date.now() };
    deactivated.set(principalId, record);
    await store.put(principalId, record);
  }

  async function reactivate(principalId: string): Promise<void> {
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
      const p = classify((await asPrincipal(graph, actor)).externalId, actor.isExternalGuest);
      return {
        ...p,
        ...(actor.teamIds ? { teamIds: actor.teamIds } : {}),
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
      };
    },
    classify,
    deactivate,
    deactivationSource(principalId: string): DeactivationSource | undefined {
      return deactivated.get(principalId)?.source;
    },
    reactivate,
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      for (const id of removedIds) {
        if (keptByDirectorySync(id) || deactivated.has(id)) continue;
        await deactivate(id, "directory-sync");
        outcome.deactivated.push(id);
      }
      for (const id of presentIds) {
        if (deactivated.get(id)?.source !== "directory-sync") continue;
        await reactivate(id);
        outcome.reactivated.push(id);
      }
      return outcome;
    },
    async listExternalMembers(): Promise<ExternalMember[]> {
      await refresh();
      return [...externals.values()];
    },
    externalMember(email: string): ExternalMember | undefined {
      return externals.get(emailKey(email));
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

async function asPrincipal(graph: PrincipalGraph, a: ActorAssertion): Promise<ActorAssertion> {
  if (a.isExternalGuest) return a;
  const kind = a.isBot ? "agent" : "person";
  return {
    ...a,
    externalId: await graph.act(a.externalId, { kind, ...(a.displayName ? { displayName: a.displayName } : {}) }),
  };
}

type AssertedRequest = {
  actor: ActorAssertion;
  conversation: { audience?: ActorAssertion[]; publishMembers?: ActorAssertion[] };
};

export async function principalRequest<R extends AssertedRequest>(
  identity: Pick<IdentityService, "principals">,
  req: R,
): Promise<R> {
  const one = (a: ActorAssertion): Promise<ActorAssertion> => asPrincipal(identity.principals, a);
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

export function emailInternal(
  identity: Pick<IdentityService, "principals" | "classify" | "externalMember">,
  email: string,
): boolean {
  const principal = identity.principals.principalOf(email);
  if (principal) return identity.classify(principal).type === "internal";
  const member = identity.externalMember(email);
  return !member || externalMemberActive(member);
}
