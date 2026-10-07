import { isProjectGroupRef } from "../projects/project-store.ts";
import { buildMemoryContextSnapshot } from "../memory/context-boundary.ts";
import { disclosedMemory, type MemoryDisclosure } from "../memory/disclosure.ts";
import type { AclStore } from "../acl/acl-store.ts";
import { parseRef } from "../acl/resource-ref.ts";
import { principalEntitledToScope } from "./context-filter.ts";
import { swallowAs } from "../util/errors.ts";
import { readContextFile } from "./context-files.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { MemoryService } from "../memory/memory-service.ts";
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
  workspace: WorkspaceStore;
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
  const handles = [
    ...resolution.grantedHandles,
    ...(await carriedFileHandles(sharingSources, input.workspace, input.files)),
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
    sharingSources,
    memoryScopeId,
    baseRecallScopes,
    memoryAccess,
    memory,
    memorySnapshot: async (auditReads = true) => {
      const heads = await Promise.all(
        read.map(async (scope) => ({
          scope,
          head: (await memory.readHead?.(scope)) ?? { content: await memory.read(scope), revision: "" },
        })),
      );
      if (auditReads) for (const { scope } of heads) recordRead(scope, "memory");
      return {
        recalled: heads
          .filter(({ head }) => head.content.trim())
          .map(({ scope, head }) => `### ${scope}\n${head.content.trim()}`)
          .join("\n\n"),
        records: heads.flatMap(({ head }) => head.records?.records ?? []),
        complete: heads.every(({ head }) => !!head.records),
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
    listSkills: async () => (await input.skills?.visibleFor(skillScopes, grantedSkills)) ?? [],
    readFile: (path: string) =>
      readContextFile(path, handles, input.workspace, input.files, (grant) => {
        if (grant.carried) recordRead(grant.ownerScopeId, grant.ownerPath);
      }),
  };
}

export type TurnContext = Awaited<ReturnType<typeof resolveTurnContext>>;
