import { personalScope, type ScopeId, type Session } from "../types.ts";
import type { SessionStore } from "./session-store.ts";
import type { CoreSearch } from "../search/core-search.ts";
import {
  artifactProvenance,
  mergeSourceProvenance,
  mergeProvenance,
  UNTRACKED_PROVENANCE,
  type SourceProvenance,
} from "../memory/facts.ts";

export interface PrivateContext {
  actorId: string;
  scopeId?: ScopeId;
  audienceScopeId?: ScopeId;
  sessionId?: string;
  personalOnly?: true;
  botActor?: boolean;
  sourceProvenance?: SourceProvenance;
}

type ContextSessions = Pick<SessionStore, "getMany" | "recordContextProvenance">;

export async function refreshPrivateContext(
  sessions: Pick<SessionStore, "recordContextProvenance"> & {
    get(id: string): Promise<Pick<Session, "id" | "scopeId" | "personalOnly" | "sourceProvenance"> | null>;
  },
  context: PrivateContext,
): Promise<PrivateContext> {
  if (!context.sessionId) return context;
  const session = await sessions.get(context.sessionId);
  if (!session || session.scopeId !== context.scopeId) throw new Error("The conversation context no longer exists.");
  const personalOnly = context.personalOnly || session.personalOnly;
  if (personalOnly && !privateSourceAllowed(context, session.scopeId))
    throw new Error("Private context requires its owner's personal scope.");
  const provenance = mergeProvenance(
    [
      ...(context.sourceProvenance ? [context.sourceProvenance] : []),
      ...(session.sourceProvenance ? [session.sourceProvenance] : []),
      ...(personalOnly ? [{ sensitivity: "ordinary" as const, sources: [], sourceUnknown: false, personalOnly }] : []),
    ],
    "ordinary",
  );
  if (context.sourceProvenance || session.sourceProvenance || personalOnly)
    context.sourceProvenance = mergeSourceProvenance([provenance]);
  if (personalOnly) {
    context.personalOnly = true;
    if (!session.personalOnly)
      context.sourceProvenance = await sessions.recordContextProvenance(session.id, session.scopeId, provenance);
  }
  return context;
}

export interface ContextSource {
  id: string;
  ownerScopeId: ScopeId;
  personalOnly?: true;
  sourceProvenance?: SourceProvenance;
}

export function privateSourceAllowed(context: PrivateContext, ownerScopeId: ScopeId): boolean {
  const owner = personalScope(context.actorId);
  return (
    context.botActor !== true &&
    ownerScopeId === owner &&
    (context.scopeId === undefined || context.scopeId === owner) &&
    (context.audienceScopeId ?? owner) === owner &&
    (context.scopeId === undefined || Boolean(context.sessionId))
  );
}

export async function inheritContextSources(
  sessions: Pick<ContextSessions, "recordContextProvenance">,
  context: PrivateContext,
  sources: readonly ContextSource[],
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const accepted: ContextSource[] = [];
  for (const source of sources) {
    if (source.personalOnly && !privateSourceAllowed(context, source.ownerScopeId)) {
      blocked.add(source.id);
      continue;
    }
    accepted.push(source);
  }
  if (accepted.length && context.sessionId && context.scopeId) {
    const provenance = mergeProvenance(
      accepted.map((source) => artifactProvenance(source.ownerScopeId, source.sourceProvenance, source.personalOnly)),
      "ordinary",
    );
    const current = context.sourceProvenance;
    const merged = mergeProvenance([...(current ? [current] : []), provenance], "ordinary");
    const covered =
      current &&
      merged.sensitivity === current.sensitivity &&
      merged.sourceUnknown === current.sourceUnknown &&
      merged.sources.every((source) => current.sources.includes(source)) &&
      (!provenance.personalOnly || context.personalOnly);
    if (!covered)
      context.sourceProvenance = await sessions.recordContextProvenance(context.sessionId, context.scopeId, provenance);
    if (provenance.personalOnly) context.personalOnly = true;
  }
  return blocked;
}

export async function inheritSessionContext(
  sessions: ContextSessions,
  context: PrivateContext,
  sourceIds: readonly string[],
): Promise<Set<string>> {
  if (!sourceIds.length) return new Set();
  const sources = await sessions.getMany({ ids: sourceIds, threadRefs: [] });
  const missing = new Set(sourceIds);
  for (const source of sources) missing.delete(source.id);
  const blocked = await inheritContextSources(
    sessions,
    context,
    sources.map((source) => ({
      id: source.id,
      ownerScopeId: source.scopeId,
      personalOnly: source.personalOnly,
      sourceProvenance: {
        ...mergeSourceProvenance([UNTRACKED_PROVENANCE, ...(source.sourceProvenance ? [source.sourceProvenance] : [])]),
        sources: [...new Set([source.scopeId, ...(source.sourceProvenance?.sources ?? [])])],
      },
    })),
  );
  return new Set([...missing, ...blocked]);
}

export async function inheritSearchContext(
  sessions: ContextSessions,
  context: PrivateContext,
  result: Awaited<ReturnType<CoreSearch["search"]>>,
): Promise<typeof result> {
  const sourceOf = (hit: (typeof result.hits)[number]) =>
    hit.backend === "conversations" && typeof hit.metadata?.sessionId === "string" ? hit.metadata.sessionId : undefined;
  const blocked = await inheritSessionContext(
    sessions,
    context,
    result.hits.flatMap((hit) => sourceOf(hit) ?? []),
  );
  return { ...result, hits: result.hits.filter((hit) => !blocked.has(sourceOf(hit) ?? "")) };
}
