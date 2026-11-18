import { personalScope, type ScopeId } from "../types.ts";
import type { SessionStore } from "./session-store.ts";
import type { CoreSearch } from "../search/core-search.ts";
import {
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

export interface ContextSource {
  id: string;
  ownerScopeId: ScopeId;
  personalOnly?: true;
  sourceProvenance?: SourceProvenance;
}

export async function inheritContextSources(
  sessions: Pick<ContextSessions, "recordContextProvenance">,
  context: PrivateContext,
  sources: readonly ContextSource[],
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const accepted: ContextSource[] = [];
  const owner = personalScope(context.actorId);
  for (const source of sources) {
    if (
      source.personalOnly &&
      (context.botActor === true ||
        source.ownerScopeId !== owner ||
        (context.scopeId !== undefined && context.scopeId !== owner) ||
        (context.audienceScopeId ?? owner) !== owner ||
        (context.scopeId !== undefined && !context.sessionId))
    ) {
      blocked.add(source.id);
      continue;
    }
    accepted.push(source);
  }
  if (accepted.length && context.sessionId && context.scopeId) {
    const provenance = mergeProvenance(
      accepted.map((source) => ({
        ...(source.sourceProvenance ?? UNTRACKED_PROVENANCE),
        sources: [...new Set([source.ownerScopeId, ...(source.sourceProvenance?.sources ?? [])])],
        ...(source.personalOnly ? { personalOnly: true as const } : {}),
      })),
      "ordinary",
    );
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
      sourceProvenance: mergeSourceProvenance([
        UNTRACKED_PROVENANCE,
        ...(source.sourceProvenance ? [source.sourceProvenance] : []),
      ]),
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
