import { DOCUMENT_GROUP_PREFIX } from "./groups.ts";
import { createHash, randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import { projectGroupRef, projectScopeId, projectIdFromGroupRef } from "../projects/project-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { personalScope, parseScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";

export type DocumentMode = "shared" | "private";
export interface DocumentConversation {
  scopeId: string;
  threadRef: string;
  sessionId: string;
  mode: DocumentMode;
}
export interface DocumentKnowledge {
  documentKey: string;
  projectId: string;
  teamScopeId: string;
  documentScopeId: string;
  mode: DocumentMode;
  sharedAccess: boolean;
}
export type DocumentRecord =
  | { kind: "surface"; projectId: string }
  | { kind: "knowledge"; groupRef: string; projectId: string }
  | {
      kind: "session";
      documentKey: string;
      projectId: string;
      scopeId: string;
      mode: DocumentMode;
      principalId?: string;
      bindingKey: string;
    }
  | { kind: "document"; projectId: string; threadRef?: string }
  | { kind: "conversation"; scopeId: string; threadRef: string }
  | { kind: "preference"; mode: DocumentMode };

function key(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function createDocumentConversations(deps: {
  backing: DurableMap<DocumentRecord>;
  projects: ProjectStore;
  sessions: SessionStore;
}) {
  async function knowledgeForSession(sessionId: string, principalId: string): Promise<DocumentKnowledge | null> {
    let cursor: string | undefined = sessionId;
    const seen = new Set<string>();
    let record: DocumentRecord | null = null;
    while (cursor) {
      if (seen.has(cursor)) throw new Error("Cyclic document session ancestry");
      seen.add(cursor);
      record = await deps.backing.get(key("session", cursor));
      if (record?.kind === "session") break;
      cursor = (await deps.sessions.get(cursor))?.parentSessionId;
    }
    if (record?.kind !== "session") return null;
    if (record.mode === "private" && !samePerson(record.principalId ?? "", principalId))
      throw new Error("Private document owner does not match session actor");
    if (cursor !== sessionId) {
      const inherited = await deps.backing.putIfAbsent(key("session", sessionId), record);
      if (
        inherited.kind !== "session" ||
        inherited.documentKey !== record.documentKey ||
        inherited.mode !== record.mode
      )
        throw new Error("Derived document session has a different association");
    }
    const members = await deps.projects.members(projectGroupRef(record.projectId));
    return {
      documentKey: record.documentKey,
      projectId: record.projectId,
      teamScopeId: projectScopeId(record.projectId),
      documentScopeId: `group:${DOCUMENT_GROUP_PREFIX}${record.documentKey}`,
      mode: record.mode,
      sharedAccess: members?.some((member) => samePerson(member, principalId)) === true,
    };
  }
  return {
    async knowledgeGroups(refs: readonly string[]) {
      return (await deps.backing.getMany(refs.map((ref) => key("knowledge", ref)))).filter(
        (record): record is Extract<DocumentRecord, { kind: "knowledge" }> => record.kind === "knowledge",
      );
    },
    knowledgeForSession,
    async publishLearning<T>(
      sessionId: string,
      principalId: string,
      applicability: "team" | "workbook",
      write: (scope: string, document: DocumentKnowledge) => Promise<T>,
    ): Promise<T | null> {
      const binding = await knowledgeForSession(sessionId, principalId);
      if (!binding || binding.mode !== "private" || !binding.sharedAccess) return null;
      return deps.projects.withRosterLock(binding.projectId, async (project) => {
        const members = await deps.projects.members(projectGroupRef(project.id));
        if (!members?.some((member) => samePerson(member, principalId))) return null;
        return write(applicability === "team" ? binding.teamScopeId : binding.documentScopeId, binding);
      });
    },
    async restart(
      sessionId: string,
      principalId: string,
    ): Promise<{ status: "ok"; conversation: DocumentConversation } | { status: "forbidden" | "conflict" }> {
      const record = await deps.backing.get(key("session", sessionId));
      if (
        record?.kind !== "session" ||
        (record.mode === "private" && !samePerson(record.principalId ?? "", principalId))
      )
        return { status: "forbidden" };
      const result = await deps.projects.withRosterLock(record.projectId, async (project) => {
        const members = await deps.projects.members(projectGroupRef(project.id));
        if (!members?.some((member) => samePerson(member, principalId))) return { status: "forbidden" as const };
        const binding = await deps.backing.get(record.bindingKey);
        const previous = await deps.sessions.get(sessionId);
        if (
          binding?.kind !== "conversation" ||
          !previous ||
          binding.threadRef !== previous.threadRef ||
          binding.scopeId !== record.scopeId
        )
          return { status: "conflict" as const };
        const threadRef = `web:${principalId}:${randomUUID()}`;
        const session = await deps.sessions.getOrCreateByThread(
          threadRef,
          record.mode === "private" ? "dm" : "group",
          record.scopeId,
          undefined,
          "web",
        );
        const associated = await deps.backing.putIfAbsent(key("session", session.id), record);
        if (
          associated.kind !== "session" ||
          associated.documentKey !== record.documentKey ||
          associated.scopeId !== record.scopeId
        )
          throw new Error("New conversation has a different document association");
        await deps.sessions.addParticipant(session.id, principalId);
        await deps.backing.put(record.bindingKey, { ...binding, threadRef });
        return {
          status: "ok" as const,
          conversation: { scopeId: record.scopeId, threadRef, sessionId: session.id, mode: record.mode },
        };
      });
      return result ?? { status: "forbidden" };
    },
    async configure(surface: string, projectId: string): Promise<boolean> {
      if (!(await deps.projects.get(projectId))) return false;
      await deps.backing.put(key("surface", surface), { kind: "surface", projectId });
      return true;
    },
    async resolve(input: {
      surface: string;
      documentId: string;
      principalId: string;
      mode?: DocumentMode;
      previous?: { scopeId: string; threadRef: string };
      copyFromDocumentId?: string;
    }): Promise<
      | { status: "ok"; conversation: DocumentConversation; copiedFromDocumentId?: string }
      | { status: "unconfigured" | "forbidden" | "conflict" }
    > {
      const configured = await deps.backing.get(key("surface", input.surface));
      if (configured?.kind !== "surface") return { status: "unconfigured" };
      const documentKey = key("document", input.surface, input.documentId);
      let document = await deps.backing.get(documentKey);
      if (input.copyFromDocumentId !== undefined) {
        if (!input.copyFromDocumentId.trim() || input.copyFromDocumentId === input.documentId || input.previous)
          return { status: "forbidden" };
        const source = await deps.backing.get(key("document", input.surface, input.copyFromDocumentId));
        if (source?.kind !== "document") return { status: "forbidden" };
        const inherited = await deps.projects.withRosterLock(source.projectId, async (project) => {
          const members = await deps.projects.members(projectGroupRef(project.id));
          if (!members?.some((member) => samePerson(member, input.principalId)))
            return { status: "forbidden" as const };
          const destination = await deps.backing.putIfAbsent(documentKey, { kind: "document", projectId: project.id });
          if (destination.kind !== "document" || destination.projectId !== project.id)
            return { status: "conflict" as const };
          return { status: "ok" as const, document: destination };
        });
        if (!inherited || inherited.status !== "ok") return inherited ?? { status: "forbidden" };
        document = inherited.document;
      }
      if (!document) {
        let projectId = configured.projectId;
        let threadRef: string | undefined;
        if (input.previous) {
          const scope = parseScopeId(input.previous.scopeId);
          const previousProject = scope.kind === "group" ? projectIdFromGroupRef(scope.ref) : null;
          if (!previousProject || !input.previous.threadRef.startsWith("web:")) return { status: "forbidden" };
          projectId = previousProject;
          const session = await deps.sessions.getByThread(input.previous.threadRef);
          if (session && session.scopeId !== input.previous.scopeId) return { status: "forbidden" };
          threadRef = session?.threadRef;
        }
        const members = await deps.projects.members(projectGroupRef(projectId));
        if (!members?.some((member) => samePerson(member, input.principalId))) return { status: "forbidden" };
        document = await deps.backing.putIfAbsent(documentKey, {
          kind: "document",
          projectId,
          ...(threadRef ? { threadRef } : {}),
        });
      }
      if (document.kind !== "document") throw new Error("Invalid document association");
      const sharedThread = document.threadRef;
      const result = await deps.projects.withRosterLock(document.projectId, async (project) => {
        const members = await deps.projects.members(projectGroupRef(project.id));
        if (!members?.some((member) => samePerson(member, input.principalId))) return { status: "forbidden" as const };
        const teamScope = projectScopeId(project.id);
        const preferenceKey = key("preference", input.surface, input.documentId, input.principalId);
        const preference = await deps.backing.get(preferenceKey);
        const mode = input.mode ?? (preference?.kind === "preference" ? preference.mode : "shared");
        const scopeId = mode === "private" ? personalScope(input.principalId) : teamScope;
        const bindingKey = key(
          "conversation",
          input.surface,
          teamScope,
          input.documentId,
          mode,
          mode === "private" ? input.principalId : "",
        );
        const priorSession = mode === "shared" && sharedThread ? await deps.sessions.getByThread(sharedThread) : null;
        const priorAssociation = priorSession ? await deps.backing.get(key("session", priorSession.id)) : null;
        const canAdopt =
          sharedThread &&
          (!priorAssociation || (priorAssociation.kind === "session" && priorAssociation.documentKey === documentKey));
        const binding = await deps.backing.putIfAbsent(bindingKey, {
          kind: "conversation",
          scopeId,
          threadRef: mode === "shared" && canAdopt ? sharedThread : `web:${input.principalId}:${randomUUID()}`,
        });
        if (binding.kind !== "conversation" || binding.scopeId !== scopeId)
          throw new Error("Document conversation binding has an invalid owner");
        const session = await deps.sessions.getOrCreateByThread(
          binding.threadRef,
          mode === "private" ? "dm" : "group",
          binding.scopeId,
          undefined,
          "web",
        );
        if (session.scopeId !== scopeId) throw new Error("Document session has a different owner");
        if (mode === "private" && !session.personalOnly) await deps.sessions.markPersonalOnly(session.id, scopeId);
        const groupRef = `${DOCUMENT_GROUP_PREFIX}${documentKey}`;
        const knowledge = await deps.backing.putIfAbsent(key("knowledge", groupRef), {
          kind: "knowledge",
          groupRef,
          projectId: project.id,
        });
        if (knowledge.kind !== "knowledge" || knowledge.projectId !== project.id)
          throw new Error("Document knowledge has a different audience");
        const association = await deps.backing.putIfAbsent(key("session", session.id), {
          kind: "session",
          documentKey,
          bindingKey,
          projectId: project.id,
          scopeId,
          mode,
          ...(mode === "private" ? { principalId: input.principalId } : {}),
        });
        if (
          association.kind !== "session" ||
          association.documentKey !== documentKey ||
          association.projectId !== project.id ||
          association.scopeId !== scopeId ||
          association.mode !== mode
        )
          return { status: "conflict" as const };
        if (association.bindingKey !== bindingKey) return { status: "conflict" as const };
        await deps.sessions.addParticipant(session.id, input.principalId);
        if (input.mode !== undefined) await deps.backing.put(preferenceKey, { kind: "preference", mode });
        return {
          status: "ok" as const,
          conversation: { scopeId, threadRef: binding.threadRef, sessionId: session.id, mode },
          ...(input.copyFromDocumentId ? { copiedFromDocumentId: input.copyFromDocumentId } : {}),
        };
      });
      return result ?? { status: "forbidden" };
    },
  };
}
export type DocumentConversations = ReturnType<typeof createDocumentConversations>;
