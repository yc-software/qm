import type { MemoryPolicy } from "../../memory/policy.ts";
import { resolveTurnContext } from "../../resolution/turn-context.ts";
import { resolveEnvironmentId } from "../../environments/environment-store.ts";
import { desktopComputerTool } from "../../../plugins/chassis/src/desktop-computer.ts";
import { withLiveTurnMembership } from "../../resolution/scope-membership.ts";
import { desktopClientForTurn } from "../turn-origin.ts";
import type { Item } from "../../sessions/items.ts";
import type {
  ApprovalGrantModes,
  CommandApprovalGrant,
  Resolution,
  ScopeId,
  Session,
  SessionType,
  TurnRequest,
} from "../../types.ts";
import { loadActorGrants } from "./approvals.ts";
import type { AdmittedTurn } from "./admit.ts";
import { replayableRequest } from "./turn-helpers.ts";
import type { OrchestratorDeps } from "./types.ts";

export interface TurnCtx extends AdmittedTurn {
  deps: OrchestratorDeps;
  resolution: Resolution;
  scopeId: ScopeId;
  actorGrants: () => Promise<CommandApprovalGrant[]>;
  approvalOwner: (sessionId: string) => {
    sessionId: string;
    request: TurnRequest;
    adminGrantModes: ApprovalGrantModes;
  };
  isCurrentSharedScopeMember: ReturnType<typeof withLiveTurnMembership>;
  filterHistory: (entries: Item[]) => Item[];
  reconcileSessionParticipants: (sessionId: string) => Promise<void>;
  strictReadOnly: boolean;
  useMemory: boolean;
  isRetry: boolean;
  reachAvailable: boolean;
}

export async function resolveTurnScope(deps: OrchestratorDeps, admitted: AdmittedTurn): Promise<TurnCtx> {
  const { input, actor, conversation, external, liveAuthorTurn, delegatedSession } = admitted;
  const resolution = await deps.resolution.resolve(conversation, actor, external);
  const actorGrants = loadActorGrants(deps.approvalGrants, actor.id);
  const approvalOwner = (sessionId: string) => ({
    sessionId,
    request: replayableRequest(input),
    adminGrantModes: resolution.approvalGrantModes,
  });
  const scopeId = deps.resolution.scopeFor(conversation, actor);
  const isCurrentSharedScopeMember = withLiveTurnMembership(deps.isCurrentSharedScopeMember, {
    actorId: actor.id,
    scopeId,
    verified: liveAuthorTurn && conversation.kind !== "dm",
  });
  let participantHistorySeqs: Set<number> | undefined;
  let participantHistoryMaxSeq = -1;
  const filterHistory = (entries: Item[]): Item[] => {
    if (!conversation.audience.length) return [];
    if (!participantHistorySeqs) return entries;
    return entries.filter((entry) => entry.seq > participantHistoryMaxSeq || participantHistorySeqs!.has(entry.seq));
  };
  const reconcileSessionParticipants = async (sessionId: string): Promise<void> => {
    const participantIds = input.sessionParticipantIds;
    if (!participantIds?.length) return;
    const desired = new Set(participantIds);
    const existing = await deps.sessions.participantsOf(sessionId);
    await Promise.all(
      existing
        .filter((principalId) => !desired.has(principalId))
        .map((principalId) => deps.sessions.removeParticipant(sessionId, principalId)),
    );
    await Promise.all(participantIds.map((principalId) => deps.sessions.addParticipant(sessionId, principalId)));
    participantHistoryMaxSeq = await deps.sessions.latestItemSeq(sessionId);
    participantHistorySeqs = new Set(
      (await deps.sessions.visibleItems(sessionId, participantIds, { beforeSeq: participantHistoryMaxSeq + 1 })).map(
        (entry) => entry.seq,
      ),
    );
  };
  return {
    ...admitted,
    deps,
    resolution,
    scopeId,
    actorGrants,
    approvalOwner,
    isCurrentSharedScopeMember,
    filterHistory,
    reconcileSessionParticipants,
    strictReadOnly:
      input.readOnly === true || input.privateSessionMessage === true || delegatedSession?.spawnMeta?.readOnly === true,
    useMemory: !external && input.skipMemory !== true,
    isRetry: (input.attempt ?? 1) > 1,
    reachAvailable: !!deps.reachExec && !!deps.directory && conversation.kind === "dm",
  };
}

export async function openTurnSession(ctx: TurnCtx): Promise<Session> {
  const { deps, conversation, input, actor, scopeId } = ctx;
  let type: SessionType = "channel";
  if (conversation.kind === "dm") type = "dm";
  else if (conversation.kind === "group") type = "group";
  const session = await deps.sessions.getOrCreateByThread(
    conversation.threadRef,
    type,
    scopeId,
    conversation.channelName,
    input.surface,
    desktopClientForTurn(input) ? [desktopComputerTool] : undefined,
  );
  if (!input.sessionParticipantIds?.length && !ctx.automatedTurn)
    await deps.sessions.addParticipant(session.id, actor.id);
  return session;
}

export async function resolveTurnWorkspace(ctx: TurnCtx, memoryPolicy: MemoryPolicy) {
  const {
    deps,
    actor,
    conversation,
    external,
    authorizationOrigin,
    liveAuthorTurn,
    scopeId,
    resolution,
    isCurrentSharedScopeMember,
    useMemory,
  } = ctx;
  const environmentId = external ? scopeId : await resolveEnvironmentId(deps.environments, scopeId);
  const rwLayer = resolution.layers.find((l) => l.mode === "rw");
  if (rwLayer && environmentId !== rwLayer.scopeId) rwLayer.scopeId = environmentId;
  for (const layer of resolution.layers) await deps.workspace.ensureScope(layer.scopeId);

  return resolveTurnContext({
    external,
    actor,
    audience: conversation.audience,
    acl: deps.acl,
    origin: authorizationOrigin,
    trustedLiveHuman: liveAuthorTurn,
    targetScope: scopeId,
    sessions: deps.sessions,
    isCurrentSharedScopeMember,
    currentScopeMembers: deps.currentScopeMembers,
    resolution,
    memoryPolicy,
    useMemory,
    memory: deps.memory,
    files: deps.files,
    skills: deps.skills,
    auditLog: deps.auditLog,
    directory: deps.directory,
    projects: deps.projects,
  });
}
