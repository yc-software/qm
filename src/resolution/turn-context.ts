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
import type { Resolution, ScopeId, Principal } from "../types.ts";
import { carriedFileHandles, sharingSourcesForTurn } from "./sharing-access.ts";

type ContextInput = Omit<Parameters<typeof sharingSourcesForTurn>[0], "posture"> & {
  resolution: Resolution;
  audience: Principal[];
  acl: Pick<AclStore, "sharedOfKindForAudience">;
  memoryPolicy: MemoryPolicy;
  useMemory: boolean;
  memory: MemoryService;
  workspace: WorkspaceStore;
  files: FileArtifactStore;
  skills?: SkillStore;
  auditLog?: AuditLog;
  recallQuery?: string;
  automatedTurn?: boolean;
};

interface MemoryReaderInput {
  memory: MemoryService;
  scopes: readonly ScopeId[];
  actorId: string;
  conversationScopeId?: ScopeId;
  recallQuery?: string;
  automatedTurn?: boolean;
  onRead?: (scope: ScopeId) => void;
}

export function contextMemory({
  memory,
  scopes,
  actorId,
  conversationScopeId,
  recallQuery,
  automatedTurn,
  onRead,
}: MemoryReaderInput) {
  return {
    async recall(): Promise<string> {
      const sections: string[] = [];
      for (const scope of scopes) {
        // recall (not read): the routed service fans out across every matching
        // provider route, while read only ever returns the first managing
        // route — the built-in notebook — so external memory providers were
        // never consulted on a turn (#1452).
        const body = (
          await memory.recall(scope, {
            query: recallQuery,
            actorId,
            conversationScopeId,
            maxChars: 6_000,
            ...(automatedTurn ? { autonomous: true } : {}),
          })
        ).trim();
        onRead?.(scope);
        if (body) sections.push(`### ${scope}\n${body}`);
      }
      return sections.join("\n\n");
    },
    async search(query: string, limit = 20): Promise<string[] | null> {
      if (!scopes.length) return null;
      const hits: string[] = [];
      for (const scope of scopes) {
        const facts = await memory.query(scope, query, limit, { actorId });
        onRead?.(scope);
        hits.push(...facts.map((fact) => (scopes.length > 1 ? `[${scope}] ${fact}` : fact)));
      }
      return hits.slice(0, limit);
    },
  };
}

// A turn-local view, never a reusable capability or a cross-turn cache.
export async function resolveTurnContext(input: ContextInput) {
  const { resolution, memoryPolicy, useMemory } = input;
  const sharingSources = await sharingSourcesForTurn({ ...input, posture: resolution.sharingPosture });
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
      resolution.orgScopeId,
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
  const memories = contextMemory({
    memory: input.memory,
    scopes: read,
    actorId: input.actor.id,
    conversationScopeId: input.targetScope,
    recallQuery: input.recallQuery,
    automatedTurn: input.automatedTurn,
    onRead: (scope) => recordRead(scope, "memory"),
  });
  const handles = [
    ...resolution.grantedHandles,
    ...(await carriedFileHandles(sharingSources, input.workspace, input.files)),
  ];
  const grantedSkills: GrantedSkillRef[] = (
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
    recall: memories.recall,
    searchMemory: memories.search,
    listFiles: () => handles,
    listSkills: async () => (await input.skills?.visibleFor(skillScopes, grantedSkills)) ?? [],
    readFile: (path: string) =>
      readContextFile(path, handles, input.workspace, input.files, (grant) => {
        if (grant.carried) recordRead(grant.ownerScopeId, grant.ownerPath);
      }),
  };
}

export type TurnContext = Awaited<ReturnType<typeof resolveTurnContext>>;
