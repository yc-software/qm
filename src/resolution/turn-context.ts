import { memoryRecallLabels } from "../memory/recall-labels.ts";
import { directoryFor, type DirectoryStore } from "../directory/directory-store.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import { disclosedMemory, type MemoryDisclosure } from "../memory/disclosure.ts";
import { readNotebook, recallAcrossScopes, searchNotebooks } from "../memory/cross-scope.ts";
import { shownFacts } from "../memory/recall-delta.ts";
import { RECALL_MAX_CHARS } from "../memory/notebook.ts";
import type { AclStore } from "../acl/acl-store.ts";
import { parseRef } from "../acl/resource-ref.ts";
import { entitledScopes } from "./context-filter.ts";
import { swallowAs } from "../util/errors.ts";
import { tracePhase } from "../../plugins/chassis/src/error-reporting.ts";
import { readContextFile } from "./context-files.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { MemoryRecallContext, MemoryService } from "../memory/memory-service.ts";
import type { MemoryFact } from "../memory/facts.ts";
import { recallMemoryScopes, type MemoryPolicy } from "../memory/policy.ts";
import type { SkillStore, GrantedSkillRef } from "../skills/skill-store.ts";
import { type Resolution, type ScopeId, type Principal } from "../types.ts";
import { carriedFileHandles, sharingSourcesForTurn } from "./sharing-access.ts";

import type { CurrentScopeMembers } from "./scope-membership.ts";
import type { Tenant } from "../tenants/context.ts";

type ContextInput = Omit<Parameters<typeof sharingSourcesForTurn>[0], "posture"> & {
  tenant: Tenant;
  resolution: Resolution;
  audienceScopeId?: ScopeId;
  external?: boolean;
  audience: Principal[];
  acl: Pick<AclStore, "sharedOfKindForAudience">;
  memoryPolicy: MemoryPolicy;
  useMemory: boolean;
  notebookOnly?: boolean;
  memory: MemoryService;
  files: FileArtifactStore;
  skills?: SkillStore;
  auditLog?: AuditLog;
  currentScopeMembers?: CurrentScopeMembers;
  directory?: DirectoryStore;
  projects?: Pick<ProjectStore, "recognizes" | "name">;
};

export async function resolveTurnContext(input: ContextInput) {
  const { resolution, memoryPolicy, useMemory } = input;
  const sharingSources = input.external
    ? []
    : await sharingSourcesForTurn({ ...input, posture: resolution.sharingPosture });
  const memoryScopeId = resolution.writableScopeId;
  const baseRecallScopes = useMemory
    ? recallMemoryScopes(memoryPolicy, memoryScopeId, resolution.readOnlyScopeIds)
    : [];
  const read = [
    ...new Set([...baseRecallScopes, ...(useMemory && memoryPolicy.recall === "visible" ? sharingSources : [])]),
  ];
  const memoryAccess =
    (useMemory && memoryPolicy.capture !== "off") || read.length
      ? {
          ...(useMemory && memoryPolicy.capture !== "off" ? { write: memoryScopeId } : {}),
          read,
          ...(input.notebookOnly ? { notebookOnly: true as const } : {}),
        }
      : undefined;
  const recordRead = (scope: ScopeId, resource: string) => {
    if (!sharingSources.includes(scope)) return;
    input.auditLog?.record(input.tenant, {
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
    ...(input.notebookOnly ? { notebookOnly: true } : {}),
    config: input.config,
    isCurrentSharedScopeMember: input.isCurrentSharedScopeMember,
    currentScopeMembers: input.currentScopeMembers,
  };
  const memory = disclosedMemory(input.memory, disclosure);
  const reader = {
    actorId: input.actor.id,
    ...(input.audienceScopeId ? { audienceScopeId: input.audienceScopeId } : {}),
  };
  const handles = [...resolution.grantedHandles, ...(await carriedFileHandles(sharingSources, input.files))];
  const memoryLabels = await memoryRecallLabels(
    read,
    input.directory && directoryFor(input.directory, input.tenant),
    input.projects,
  );
  return {
    sharingSources,
    memoryScopeId,
    baseRecallScopes,
    memoryAccess,
    memory,
    memoryLabels,
    memorySnapshot: async () => {
      const notebooks = await tracePhase(
        "turn.memory_snapshot",
        () => Promise.all(read.map(async (scope) => ({ scope, facts: await memory.facts?.(scope) }))),
        { counts: (loaded) => ({ "qm.facts": loaded.reduce((sum, { facts }) => sum + (facts?.length ?? 0), 0) }) },
      );
      for (const { scope } of notebooks) recordRead(scope, "memory");
      return {
        held: new Map(notebooks.map(({ scope, facts }) => [scope, shownFacts(facts ?? [])])),
        loaded: new Map(notebooks.flatMap(({ scope, facts }) => (facts?.length ? [[scope, facts] as const] : []))),
        facts: notebooks.flatMap(({ facts }) => facts ?? []),
        complete: notebooks.every(({ facts }) => !!facts),
      };
    },
    recallMemory: (
      query: string,
      disclosedFacts?: Promise<ReadonlyMap<ScopeId, readonly MemoryFact[]>>,
      report?: MemoryRecallContext["report"],
      text?: string,
      sessionId?: string,
    ) =>
      tracePhase(
        "turn.memory_recall",
        () =>
          recallAcrossScopes(
            memory,
            read,
            {
              query,
              ...(text ? { input: text } : {}),
              ...reader,
              maxChars: RECALL_MAX_CHARS,
              ...(disclosedFacts ? { disclosedFacts } : {}),
              ...(report ? { report } : {}),
              ...(sessionId ? { sessionId } : {}),
            },
            memoryLabels,
          ),
        { counts: (recalled) => ({ "qm.recalled": recalled.length }) },
      ),
    searchMemory: async (
      query: string,
      limit = 20,
      scope?: ScopeId,
      report?: MemoryRecallContext["report"],
      sessionId?: string,
    ): Promise<string[] | null> => {
      const hits = await searchNotebooks(memory, read, query, limit, scope, {
        ...reader,
        ...(report ? { report } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
      if (hits) for (const source of scope === undefined ? read : [scope]) recordRead(source, "memory");
      return hits;
    },
    readMemory: async (scope: ScopeId): Promise<string | null> => {
      if (!read.includes(scope)) return null;
      const body = await readNotebook(memory, scope);
      recordRead(scope, "memory");
      return body;
    },
    listFiles: () => handles,
    listSkills: async (sources?: readonly string[]) => {
      const sharingSources = input.external
        ? []
        : await sharingSourcesForTurn({ ...input, posture: resolution.sharingPosture });
      const skillScopes = [
        ...new Set([
          memoryScopeId,
          ...resolution.readOnlyScopeIds.filter((scope) => scope !== resolution.orgScopeId),
          ...sharingSources,
          ...(!input.external ? [resolution.orgScopeId] : []),
        ]),
      ];
      const grantedSkills: GrantedSkillRef[] = input.external
        ? []
        : (
            await input.acl
              .sharedOfKindForAudience(
                input.tenant,
                "skill",
                input.audience,
                input.targetScope,
                resolution.orgScopeId,
                entitledScopes,
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
