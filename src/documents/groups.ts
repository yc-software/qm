import { samePerson } from "../directory/person.ts";
import type { ManagedGroupDirectory } from "../resolution/scope-membership.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import { projectGroupRef } from "../projects/project-store.ts";
import type { DocumentConversations } from "./conversations.ts";

export const DOCUMENT_GROUP_PREFIX = "document-";

export function createDocumentGroups(
  documents: DocumentConversations,
  projects: ProjectStore,
): ManagedGroupDirectory & Pick<ProjectStore, "membersMany"> {
  const isDocument = (ref: string) => ref.startsWith(DOCUMENT_GROUP_PREFIX);
  const parent = async (ref: string) => (await documents.knowledgeGroups([ref]))[0];
  const parentRef = async (ref: string) => {
    const group = await parent(ref);
    return group ? projectGroupRef(group.projectId) : null;
  };
  return {
    recognizes: (ref) => isDocument(ref) || projects.recognizes(ref),
    async membership(ref, principalId) {
      if (!isDocument(ref)) return projects.membership(ref, principalId);
      const id = await parentRef(ref);
      return id ? ((await projects.members(id)) ?? []).some((member) => samePerson(member, principalId)) : false;
    },
    async members(ref) {
      if (!isDocument(ref)) return projects.members(ref);
      const id = await parentRef(ref);
      return id ? ((await projects.members(id)) ?? []) : [];
    },
    async membersMany(refs) {
      const unique = [...new Set(refs)];
      const groups = await documents.knowledgeGroups(unique.filter(isDocument));
      const parents = new Map(groups.map((group) => [group.groupRef, projectGroupRef(group.projectId)]));
      const rosters = await projects.membersMany([
        ...new Set([...unique.filter((ref) => !isDocument(ref)), ...parents.values()]),
      ]);
      return new Map(unique.map((ref) => [ref, rosters.get(parents.get(ref) ?? ref) ?? []]));
    },
    async version(ref) {
      if (!isDocument(ref)) return projects.version(ref);
      const id = await parentRef(ref);
      return id ? projects.version(id) : undefined;
    },
    async withVersion<T>(ref: string, version: string | undefined, fn: () => Promise<T>) {
      if (!isDocument(ref)) return projects.withVersion(ref, version, fn);
      const id = await parentRef(ref);
      return id ? projects.withVersion(id, version, fn) : undefined;
    },
    slackChannel: (ref) => (isDocument(ref) ? Promise.resolve(undefined) : projects.slackChannel(ref)),
  };
}
