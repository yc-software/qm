import {
  MemoryFactsMissing,
  mergeProvenance,
  UNTRACKED_PROVENANCE,
  parseFactId,
  type MemoryCaptureMetadata,
} from "../memory/facts.ts";
import { writeFacts } from "../memory/provider-outcome.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { ambientTenant } from "../tenants/context.ts";
import type { DocumentConversations } from "./conversations.ts";
import { DOCUMENT_GROUP_PREFIX } from "./groups.ts";
import { projectIdFromGroupRef } from "../projects/project-store.ts";
import type { MemoryAuthority, MemoryService, MemoryEdit } from "../memory/memory-service.ts";
import {
  memoryDisclosurePolicy,
  disclosedMemory,
  MemoryDisclosureDenied,
  type MemoryDisclosure,
} from "../memory/disclosure.ts";
import { parseScopeId, personalScope } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import type { SessionStore } from "../sessions/session-store.ts";

export async function nativeDocumentSources(
  documents: Pick<DocumentConversations, "knowledgeGroups">,
  nativeScopes: readonly string[],
  scopes: readonly string[],
): Promise<string[]> {
  const native = new Set(nativeScopes);
  const refs = (items: readonly string[]) =>
    items.flatMap((scope) => {
      const parsed = parseScopeId(scope);
      return parsed.kind === "group" && parsed.ref.startsWith(DOCUMENT_GROUP_PREFIX) ? [parsed.ref] : [];
    });
  const foreign = refs(scopes.filter((scope) => !native.has(scope)));
  if (!foreign.length) return [];
  const groups = await documents.knowledgeGroups([...new Set([...foreign, ...refs(nativeScopes)])]);
  const projects = new Set(
    nativeScopes.flatMap((scope) => {
      const parsed = parseScopeId(scope);
      const id = parsed.kind === "group" ? projectIdFromGroupRef(parsed.ref) : null;
      return id ? [id] : [];
    }),
  );
  for (const group of groups) if (native.has(`group:${group.groupRef}`)) projects.add(group.projectId);
  return [...groups.filter((group) => projects.has(group.projectId)).map((group) => `group:${group.groupRef}`)];
}

export function createDocumentMemory(
  memory: MemoryService,
  documents: DocumentConversations,
  auditLog: AuditLog,
  sessions?: Pick<SessionStore, "get">,
): MemoryService {
  async function metadata(
    scope: string,
    by: MemoryAuthority | undefined,
    context: MemoryCaptureMetadata | undefined,
  ): Promise<MemoryCaptureMetadata | undefined> {
    if (!context?.sessionId || !by?.actorId || by.context !== "conversation") return context;
    const sessionId = context.sessionId;
    const session = await sessions?.get(sessionId);
    if (session?.sourceProvenance)
      context = {
        ...context,
        inheritedFacts: [...(context.inheritedFacts ?? [UNTRACKED_PROVENANCE]), session.sourceProvenance],
      };
    if (session?.personalOnly) {
      const owner = personalScope(by.actorId);
      if (session.scopeId !== owner || scope !== owner) throw new MemoryDisclosureDenied();
      context = { ...context, personalOnly: true };
    }
    const binding = await documents.knowledgeForSession(sessionId, by.actorId);
    if (!binding) return context;
    if (binding.mode === "private") {
      const target = parseScopeId(scope);
      if (target.kind !== "personal" || !samePerson(target.ref, by.actorId)) throw new MemoryDisclosureDenied();
      return { ...context, document: binding, personalOnly: true };
    }
    if (!binding.sharedAccess || (scope !== binding.documentScopeId && scope !== binding.teamScopeId))
      throw new MemoryDisclosureDenied();
    return { ...context, document: binding };
  }
  return {
    ...memory,
    withDisclosure: (access: MemoryDisclosure) => {
      const nativeSources = async (scopes: readonly string[]) => {
        const inherited = (await access.nativeSources?.(scopes)) ?? [];
        return [...inherited, ...(await nativeDocumentSources(documents, access.nativeScopes, scopes))];
      };
      return createDocumentMemory(disclosedMemory(memory, { ...access, nativeSources }), documents, auditLog, sessions);
    },
    async capture(scope, facts, at, by, context) {
      const bound = await metadata(scope, by, context);
      const added = await memory.capture(scope, facts, at, by, context ? { ...context, ...bound } : undefined);
      if (bound?.document && by?.actorId)
        auditLog.record(ambientTenant(), {
          at: Date.now(),
          principalId: by.actorId,
          action: "documents.memory.capture",
          resource: context?.sessionId ?? "",
          scopeLabel: scope,
          detail: JSON.stringify({ added, private: bound.personalOnly === true }),
        });
      return added;
    },
    ...(memory.edit
      ? {
          async edit(scope, edits, by, context) {
            await memory.edit!(scope, edits, by, await metadata(scope, by, context));
          },
        }
      : {}),
  };
}

export async function publishDocumentLearning(
  documents: Pick<DocumentConversations, "publishLearning">,
  memory: MemoryService,
  auditLog: AuditLog,
  input: {
    sessionId: string;
    actorId: string;
    applicability: "team" | "workbook";
    facts: MemoryEdit[];
    runId?: string;
    disclosure: Pick<
      MemoryDisclosure,
      "actor" | "currentScopeMembers" | "isCurrentSharedScopeMember" | "config" | "nativeScopes"
    >;
  },
) {
  return documents.publishLearning(input.sessionId, input.actorId, input.applicability, async (scope, document) => {
    const notebook = await memory.facts?.(personalScope(input.actorId));
    if (!notebook)
      throw new MemoryDisclosureDenied("This memory provider cannot verify the selected fact for publication.");
    const selected = input.facts.map((requested) => {
      const id = parseFactId(requested.id);
      const fact = notebook.find((candidate) => candidate.id === id);
      if (!fact) throw new MemoryFactsMissing([id]);
      if (fact.text !== requested.text)
        throw new MemoryDisclosureDenied("The selected learning changed after approval. Read it again before sharing.");
      return fact;
    });
    const provenance = mergeProvenance(selected);
    const sources = provenance.sources.filter((source) => {
      const parsed = parseScopeId(source);
      return parsed.kind !== "personal" || !samePerson(parsed.ref, input.actorId);
    });
    const published = { ...provenance, personalOnly: undefined, sources: sources.length ? sources : [scope] };
    const audience = await input.disclosure.currentScopeMembers?.(scope);
    const access: MemoryDisclosure = {
      ...input.disclosure,
      targetScope: scope,
      nativeScopes: [scope, document.teamScopeId, ...input.disclosure.nativeScopes],
      audience: audience ?? [],
      open: true,
    };
    if (!audience?.length || !(await memoryDisclosurePolicy(access).allows(scope, published)))
      throw new MemoryDisclosureDenied(
        "The selected learning cannot be published here while its source restrictions remain in effect.",
      );
    const result = await writeFacts(
      memory,
      scope,
      selected.map((fact) => fact.text),
      { actorId: input.actorId, context: "self" },
      {
        mode: "explicit",
        conversationScopeId: scope,
        sessionId: input.sessionId,
        inheritedFacts: [published],
        sensitivity: published.sensitivity,
      },
      input.runId,
    );
    if (!result.added && !result.outcomes.length && !result.problems.length) {
      const saved = await disclosedMemory(memory, access).facts?.(scope);
      if (!selected.every((fact) => saved?.some((copy) => copy.text === fact.text)))
        throw new MemoryDisclosureDenied(
          "The destination has no enabled notebook that can preserve this learning's source restrictions.",
        );
    }
    auditLog.record(ambientTenant(), {
      at: Date.now(),
      principalId: input.actorId,
      action: "documents.memory.publish",
      resource: input.sessionId,
      scopeLabel: scope,
      detail: JSON.stringify({ added: result.added, applicability: input.applicability }),
    });
    return result;
  });
}
