import type { AuditLog } from "../audit/audit-log.ts";
import { ambientTenant } from "../tenants/context.ts";
import type { DocumentConversations } from "./conversations.ts";
import type { MemoryCaptureMetadata } from "../memory/facts.ts";
import type { MemoryAuthority, MemoryService } from "../memory/memory-service.ts";
import { MemoryDisclosureDenied } from "../memory/disclosure.ts";
import { parseScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";

export function createDocumentMemory(
  memory: MemoryService,
  documents: DocumentConversations,
  auditLog: AuditLog,
): MemoryService {
  async function metadata(
    scope: string,
    by: MemoryAuthority | undefined,
    context: MemoryCaptureMetadata | undefined,
  ): Promise<MemoryCaptureMetadata | undefined> {
    if (!context?.sessionId || !by?.actorId || by.context !== "conversation") return context;
    const binding = await documents.knowledgeForSession(context.sessionId, by.actorId);
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
    ...(memory.withDisclosure
      ? { withDisclosure: (access) => createDocumentMemory(memory.withDisclosure!(access), documents, auditLog) }
      : {}),
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
