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
export type DocumentRecord =
  | { kind: "surface"; projectId: string }
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
  return {
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
    }): Promise<{ status: "ok"; conversation: DocumentConversation } | { status: "unconfigured" | "forbidden" }> {
      const configured = await deps.backing.get(key("surface", input.surface));
      if (configured?.kind !== "surface") return { status: "unconfigured" };
      const documentKey = key("document", input.surface, input.documentId);
      let document = await deps.backing.get(documentKey);
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
        const binding = await deps.backing.putIfAbsent(bindingKey, {
          kind: "conversation",
          scopeId,
          threadRef: mode === "shared" && sharedThread ? sharedThread : `web:${input.principalId}:${randomUUID()}`,
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
        await deps.sessions.addParticipant(session.id, input.principalId);
        if (input.mode !== undefined) await deps.backing.put(preferenceKey, { kind: "preference", mode });
        return {
          status: "ok" as const,
          conversation: { scopeId, threadRef: binding.threadRef, sessionId: session.id, mode },
        };
      });
      return result ?? { status: "forbidden" };
    },
  };
}
export type DocumentConversations = ReturnType<typeof createDocumentConversations>;
