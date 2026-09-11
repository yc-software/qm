import { MEMORY_FILE } from "../memory/memory-service.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { GrantedHandle, Principal, ScopeId, TurnOrigin } from "../types.ts";
import { parseScopeId, personalScope } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { relative } from "node:path";
import type { ScopedConfigStore } from "./config-store.ts";
import type { IsCurrentSharedScopeMember } from "./scope-membership.ts";
import type { SharingPosture } from "./sharing-posture.ts";

export const MAX_OPEN_SHARED_SCOPES = 25;
const MAX_OPEN_FILES = 200;
const MAX_OPEN_CANDIDATES = 100;

interface SharingSourcesInput {
  posture: SharingPosture | undefined;
  actor: Principal;
  origin: TurnOrigin;
  trustedLiveHuman: boolean;
  targetScope: ScopeId;
  config?: ScopedConfigStore;
  sessions: Pick<SessionStore, "listByParticipant">;
  isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
}

export async function sharingSourcesForTurn(input: SharingSourcesInput): Promise<ScopeId[]> {
  if (
    input.posture !== "open" ||
    input.actor.type !== "internal" ||
    input.origin.kind !== "human" ||
    !input.trustedLiveHuman ||
    !input.config ||
    !input.isCurrentSharedScopeMember
  )
    return [];
  const targetKind = parseScopeId(input.targetScope).kind;
  const personal = personalScope(input.actor.id);
  if (targetKind === "channel" || targetKind === "group") {
    return (await input.isCurrentSharedScopeMember(input.actor.id, input.targetScope)) ? [personal] : [];
  }
  if (targetKind !== "personal") return [];
  const sessions = await input.sessions
    .listByParticipant(input.actor.id, { limit: MAX_OPEN_CANDIDATES })
    .catch(() => []);
  const candidates = [...sessions]
    .filter((session) => {
      const kind = parseScopeId(session.scopeId).kind;
      return kind === "channel" || kind === "group";
    })
    .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
  const seen = new Set<ScopeId>();
  const sources: ScopeId[] = [];
  for (const session of candidates.slice(0, MAX_OPEN_CANDIDATES)) {
    if (seen.has(session.scopeId)) continue;
    seen.add(session.scopeId);
    if (!(await input.isCurrentSharedScopeMember(input.actor.id, session.scopeId))) continue;
    if ((await input.config.resolveSharingPostureDurable(personal, session.scopeId)) !== "open") continue;
    sources.push(session.scopeId);
    if (sources.length >= MAX_OPEN_SHARED_SCOPES) break;
  }
  return sources;
}

function handleSource(scope: ScopeId): string {
  return scope.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function handlePath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[^A-Za-z0-9._-]+/g, "-"))
    .join("/");
}

export async function carriedFileHandles(
  sourceScopes: readonly ScopeId[],
  workspace: Pick<WorkspaceStore, "list" | "scopeDir">,
  files: Pick<FileArtifactStore, "listOwnedByScopes">,
): Promise<GrantedHandle[]> {
  const handles = new Map<string, GrantedHandle>();
  for (const sourceScope of sourceScopes) {
    const remaining = MAX_OPEN_FILES - handles.size;
    if (remaining <= 0) break;
    const [workspacePaths, page] = await Promise.all([
      workspace.list(sourceScope, { limit: remaining }),
      files.listOwnedByScopes([sourceScope], { limit: remaining }),
    ]);
    const artifacts = page.files.map((file) => file.path);
    const workspaceBase = workspace.scopeDir(sourceScope);
    const ownedPaths = workspacePaths.map((path) => {
      const rel = relative(workspaceBase, path);
      return rel.startsWith("..") ? "" : rel;
    });
    for (const ownerPath of [...ownedPaths, ...artifacts]) {
      if (handles.size >= MAX_OPEN_FILES) break;
      const relative = handlePath(ownerPath);
      if (relative === MEMORY_FILE) continue;
      if (!relative) continue;
      const key = `${sourceScope}\0${ownerPath}`;
      handles.set(key, {
        carried: true,
        handlePath: `shared/open-${handleSource(sourceScope)}/${relative}`,
        ownerScopeId: sourceScope,
        ownerPath,
        permission: "read",
      });
    }
  }
  return [...handles.values()];
}
