import { isProjectGroupRef } from "../projects/project-store.ts";
import { buildMemoryContextSnapshot } from "../memory/context-boundary.ts";
import { disclosedMemory, type MemoryDisclosure } from "../memory/disclosure.ts";
import type { AclStore } from "../acl/acl-store.ts";
import { parseRef } from "../acl/resource-ref.ts";
import { principalEntitledToScope } from "./context-filter.ts";
import { swallowAs } from "../util/errors.ts";
import { readContextFile } from "./context-files.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import { renderFacts } from "../memory/facts.ts";
import { recallMemoryScopes, writableMemoryScope, type MemoryPolicy } from "../memory/policy.ts";
import type { SkillStore, GrantedSkillRef } from "../skills/skill-store.ts";
import { parseScopeId, type Resolution, type ScopeId, type Principal } from "../types.ts";
import { carriedFileHandles, sharingSourcesForTurn } from "./sharing-access.ts";

import type { CurrentScopeMembers } from "./scope-membership.ts";

type ContextInput = Omit<Parameters<typeof sharingSourcesForTurn>[0], "posture"> & {
  resolution: Resolution;
  external?: boolean;
  audience: Principal[];
  acl: Pick<AclStore, "sharedOfKindForAudience">;
  memoryPolicy: MemoryPolicy;
  useMemory: boolean;
  memory: MemoryService;
  files: FileArtifactStore;
  skills?: SkillStore;
  auditLog?: AuditLog;
  currentScopeMembers?: CurrentScopeMembers;
};

// A turn-local view, never a reusable capability or a cross-turn cache.
export async function resolveTurnContext(input: ContextInput) {
  const { resolution, memoryPolicy, useMemory } = input;
  const sharingSources = input.external
    ? []
    : await sharingSourcesForTurn({ ...input, posture: resolution.sharingPosture });
  const memoryScopeId = writableMemoryScope(resolution.layers, input.targetScope);
  const baseRecallScopes = useMemory ? recallMemoryScopes(memoryPolicy, resolution.layers, memoryScopeId) : [];
  const read = [
    ...new Set([...baseRecallScopes, ...(useMemory && memoryPolicy.recall === "visible" ? sharingSources : [])]),
  ];
  const memoryAccess =
    (useMemory && memoryPolicy.capture !== "off") || read.length
      ? { ...(useMemory && memoryPolicy.capture !== "off" ? { write: memoryScopeId } : {}), read }
      : undefined;
  const recordRead = (scope: ScopeId, resource: string) => {
    if (!sharingSources.includes(scope)) return;
    input.auditLog?.record({
      at: Date.now(),
      principalId: input.actor.id,
      action: "sharing.cross_context_read",
      resource,
      scopeLabel: input.targetScope,
      detail: JSON.stringify({ actor: input.actor.id, source: scope, target: input.targetScope }),
    });
  };
  const disclosure: MemoryDisclosure = {
    actor: input.actor,
    targetScope: input.targetScope,
    nativeScopes: baseRecallScopes,
    audience: input.audience,
    open: resolution.sharingPosture === "open",
    config: input.config,
    isCurrentSharedScopeMember: input.isCurrentSharedScopeMember,
    currentScopeMembers: input.currentScopeMembers,
  };
  const memory = disclosedMemory(input.memory, disclosure);
  const handles = [...resolution.grantedHandles, ...(await carriedFileHandles(sharingSources, input.files))];
  return {
    sharingSources,
    memoryScopeId,
    baseRecallScopes,
    memoryAccess,
    memory,
    memorySnapshot: async (auditReads = true) => {
      const notebooks = await Promise.all(
        read.map(async (scope) => {
          const facts = await memory.facts?.(scope);
          return { scope, facts, content: facts ? renderFacts(facts) : await memory.read(scope) };
        }),
      );
      if (auditReads) for (const { scope } of notebooks) recordRead(scope, "memory");
      return {
        recalled: notebooks
          .filter(({ content }) => content.trim())
          .map(({ scope, content }) => `### ${scope}\n${content.trim()}`)
          .join("\n\n"),
        facts: notebooks.flatMap(({ facts }) => facts ?? []),
        complete: notebooks.every(({ facts }) => !!facts),
        snapshot: buildMemoryContextSnapshot({
          targetScope: input.targetScope,
          audience: isProjectGroupRef(parseScopeId(input.targetScope).ref ?? "")
            ? []
            : ((await input.currentScopeMembers?.(input.targetScope)) ??
              (parseScopeId(input.targetScope).kind === "channel" ? [] : input.audience)),
        }),
      };
    },
    searchMemory: async (query: string, limit = 20): Promise<string[] | null> => {
      if (!read.length) return null;
      const hits = await Promise.all(
        read.map(async (scope) => {
          const facts = await memory.query(scope, query, limit, { actorId: input.actor.id });
          recordRead(scope, "memory");
          return facts.map((fact) => (read.length > 1 ? `[${scope}] ${fact}` : fact));
        }),
      );
      return hits.flat().slice(0, limit);
    },
    listFiles: () => handles,
    listSkills: async (sources?: readonly string[]) => {
      const sharingSources = input.external
        ? []
        : await sharingSourcesForTurn({ ...input, posture: resolution.sharingPosture });
      const skillScopes = [
        ...new Set([
          memoryScopeId,
          ...resolution.layers
            .filter((layer) => layer.mode === "ro" && layer.scopeId !== resolution.orgScopeId)
            .map((layer) => layer.scopeId),
          ...sharingSources,
          ...(!input.external ? [resolution.orgScopeId] : []),
        ]),
      ];
      const grantedSkills: GrantedSkillRef[] = input.external
        ? []
        : (
            await input.acl
              .sharedOfKindForAudience(
                "skill",
                input.audience,
                input.targetScope,
                resolution.orgScopeId,
                principalEntitledToScope,
              )
              .catch(swallowAs("context: skill grants for audience", []))
          ).map((grant) => ({ id: parseRef(grant.ref).id, ownerScopeId: grant.ownerScopeId }));
      return {
        skills:
          (await input.skills?.visibleFor(
            sources ? skillScopes.filter((scope) => sources.includes(scope)) : skillScopes,
            sources ? grantedSkills.filter((grant) => sources.includes(grant.ownerScopeId)) : grantedSkills,
          )) ?? [],
        sharingSources,
        skillSources: [...new Set([...skillScopes, ...grantedSkills.map((grant) => grant.ownerScopeId)])],
      };
    },
    readFile: (path: string) =>
      readContextFile(path, handles, input.files, (grant) => {
        if (grant.carried) recordRead(grant.ownerScopeId, grant.fileId);
      }),
  };
}

export type TurnContext = Awaited<ReturnType<typeof resolveTurnContext>>;
