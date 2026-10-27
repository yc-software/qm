import { isSubagentThreadRef } from "../sessions/thread-ref.ts";
import { type ScopeId, type TurnRequest, type TurnResult } from "../types.ts";
import { isTerminal, type Run } from "../runs/run-store.ts";
import { sleep } from "../util/async.ts";
import type { RunSignal } from "../runs/run-signal-store.ts";
import { reportFailureAs, swallow } from "../util/errors.ts";
import { adminSessionUrl } from "../util/admin-links.ts";
import {
  openGroupViaSurface,
  resolveReachTarget,
  type ReachOpts,
  type ReachResolution,
  type ReachTarget,
  type ReachDirectory,
} from "../reach/reach.ts";
import { createSurfaceContextPuller } from "./surface-context-puller.ts";
import { projectScopeId, type Project } from "../projects/project-store.ts";

import { type App, type AppDeps } from "./app-types.ts";
import { createArtifactAccess, createScopeAccess } from "./app-scope-access.ts";
import { createApprovalAccess, createViewerResources, createViewerScopes } from "./app-viewer-access.ts";

const DRIVE_RECHECK_MS = 1_000;

function detached<T extends { clientTools?: unknown; desktopClientId?: unknown }>(
  request: T,
): Omit<T, "clientTools" | "desktopClientId"> {
  const { clientTools: _clientTools, desktopClientId: _desktopClientId, ...rest } = request;
  return rest;
}

function bareRequest<
  T extends {
    clientTools?: unknown;
    desktopClientId?: unknown;
    approval?: unknown;
    attachments?: unknown;
    displayText?: unknown;
  },
>(request: T) {
  const { approval: _approval, attachments: _attachments, displayText: _displayText, ...rest } = detached(request);
  return rest;
}

function replayableRequest(request: TurnRequest, prior: Run["request"] | undefined): TurnRequest {
  const { approval: _approval, redeliveryKey: _redeliveryKey, ...base } = detached(request);
  return {
    ...base,
    ...(base.model === undefined && prior?.model !== undefined ? { model: prior.model } : {}),
    ...(base.thinkingLevel === undefined && prior?.thinkingLevel !== undefined
      ? { thinkingLevel: prior.thinkingLevel }
      : {}),
    ...(base.fastMode === undefined && prior?.fastMode !== undefined ? { fastMode: prior.fastMode } : {}),
    ...(base.timezone === undefined && prior?.timezone !== undefined ? { timezone: prior.timezone } : {}),
  };
}

function createRunWaits(deps: AppDeps, adminLink: (sessionId: string) => string | undefined) {
  async function withAdminLink(result: TurnResult): Promise<TurnResult> {
    if (!result.sessionId) return result;
    const byThread = await deps.sessions.getByThread(result.sessionId);
    let sessionId: string | undefined;
    if (byThread) sessionId = byThread.id;
    else if (await deps.sessions.get(result.sessionId)) sessionId = result.sessionId;
    if (!sessionId) return { ...result, sessionId: undefined };
    const adminUrl = adminLink(sessionId);
    return { ...result, sessionId, ...(adminUrl ? { adminUrl } : {}) };
  }

  async function drive(runId: string): Promise<TurnResult> {
    deps.startTurns?.();
    const timeoutMs = deps.runWaitMs ?? 60_000;
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const run = await deps.runs.get(runId);
      if (!run) throw new Error(`run ${runId} not found`);
      if (isTerminal(run.status)) {
        return withAdminLink(
          run.result ?? { status: "failed", sessionId: run.sessionId, reason: "run produced no result" },
        );
      }
      if (deps.shutdown?.().aborted) return { status: "queued", sessionId: run.sessionId, runId };
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
      await sessionChange(run.sessionId, Math.min(DRIVE_RECHECK_MS, remaining));
    }
  }

  function sessionChange(threadRef: string, ms: number): Promise<void> {
    const bus = deps.sessionStateBus;
    if (!bus) return sleep(Math.min(ms, 100));
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const stop = bus.subscribe((event) => {
        if (event.threadRef === threadRef) done();
      });
    });
  }

  return { withAdminLink, drive };
}

function createProjectRosterSync(
  deps: AppDeps,
  audit: (principalId: string, action: string, resource: string, scopeLabel: ScopeId) => void,
) {
  async function syncProjectChannelRoster(project: Project, actorId: string): Promise<void> {
    const link = project.slackChannel;
    if (!link || !deps.projects) return;
    const roster = await deps.directory
      .channelMemberIds(link.channelId)
      .catch(reportFailureAs("api: roster", undefined));
    if (roster === undefined) return;
    const derived = roster.filter((m) => deps.identity.isInternal(deps.identity.classify(m)));
    const channels = await deps.directory.listChannels().catch(reportFailureAs("api: project channel list", []));
    const channel = channels.find((c) => c.channelId === link.channelId);
    const prev = project.channelMemberIds ?? [];
    const manual = new Set([project.ownerId, ...project.memberIds]);
    const prevSet = new Set(prev);
    const nextSet = new Set(derived);
    await deps.projects.syncChannelMembers(project.id, derived, channel?.name, async ({ project: p, changed }) => {
      if (!changed) return;
      for (const m of derived) {
        if (prevSet.has(m) || manual.has(m)) continue;
        audit(actorId, "project.member.add", m, projectScopeId(p.id));
        await reconcileProjectMember(p, m, true);
      }
      for (const m of prev) {
        if (nextSet.has(m) || manual.has(m)) continue;
        audit(actorId, "project.member.remove", m, projectScopeId(p.id));
        await reconcileProjectMember(p, m, false);
      }
    });
  }

  async function syncLinkedProjectRosters(): Promise<void> {
    if (!deps.projects) return;
    for (const project of await deps.projects.listLinked().catch(() => [])) {
      await syncProjectChannelRoster(project, "directory-sync").catch((err) =>
        swallow(`projects: channel roster sync for ${project.id}`, err),
      );
    }
  }

  async function reconcileProjectMember(project: Project, memberId: string, add: boolean): Promise<void> {
    const sessions = await deps.sessions.listByScope(projectScopeId(project.id));
    for (const session of sessions) {
      if (add) await deps.sessions.addParticipant(session.id, memberId, undefined, { includeHistory: true });
      else await deps.sessions.removeParticipant(session.id, memberId);
    }
  }

  return { syncProjectChannelRoster, syncLinkedProjectRosters, reconcileProjectMember };
}

async function replayOrphanedRunSignals(
  deps: AppDeps,
  app: App,
  runId: string,
): Promise<Array<{ signal: RunSignal; replayRunId?: string }>> {
  if (!deps.signals) return [];
  const drained: Array<{ signal: RunSignal; replayRunId?: string }> = [];
  const completed = await deps.runs.get(runId);
  if (completed && isSubagentThreadRef(completed.sessionId)) {
    const signals = deps.signals;
    return deps.advisoryLock.withLock(`run-signal-replay:${runId}`, async () => {
      for (const { id, signal } of await signals.pending(runId)) {
        if (signal.kind === "abort" || signal.kind === "client_result" || !signal.text?.trim()) {
          await signals.acknowledge(runId, id);
          continue;
        }
        let replayRunId: string | undefined;
        const dedupKey = `session-signal:${runId}:${id}`;
        if (signal.sessionRequest) {
          const { run } = await deps.runs.enqueue({
            sessionId: completed.sessionId,
            request: detached(signal.sessionRequest),
            dedupKey,
            maxAttempts: deps.maxAttempts,
          });
          replayRunId = run.id;
        } else if (signal.request) {
          const replayed = await app.turn(
            { ...replayableRequest(signal.request, completed.request), async: true, idempotencyKey: dedupKey },
            { signalDedupKey: dedupKey },
          );
          replayRunId = replayed.runId;
          if (!replayRunId && replayed.status !== "refused") continue;
        } else {
          const { run } = await deps.runs.enqueue({
            sessionId: completed.sessionId,
            request: {
              ...bareRequest(completed.request),
              text: signal.text,
              origin: { kind: "automation", screenData: signal.text },
            },
            dedupKey,
            maxAttempts: deps.maxAttempts,
          });
          replayRunId = run.id;
        }
        await signals.acknowledge(runId, id);
        drained.push({ signal, ...(replayRunId ? { replayRunId } : {}) });
      }
      return drained;
    });
  }
  const signals = deps.signals;
  return deps.advisoryLock.withLock(`run-signal-replay:${runId}`, async () => {
    for (const { id, signal } of await signals.pending(runId)) {
      if (signal.kind === "abort" || signal.kind === "client_result") {
        await signals.acknowledge(runId, id);
        continue;
      }
      let replayRunId: string | undefined;
      let replayOutcomeKnown = true;
      if (signal.request) {
        try {
          const prior = (await deps.runs.get(runId))?.request;
          const replayed = await app.turn({ ...replayableRequest(signal.request, prior), async: true });
          replayRunId = replayed.runId;
        } catch (err) {
          replayOutcomeKnown = false;
          swallow(`signals: orphaned-signal replay for run ${runId}`, err);
        }
      }
      if (!replayRunId && replayOutcomeKnown && signal.text?.trim()) {
        const orphanRun = await deps.runs.get(runId);
        if (orphanRun) {
          try {
            const { run: fresh } = await deps.runs.enqueue({
              sessionId: orphanRun.sessionId,
              request: { ...bareRequest(orphanRun.request), text: signal.text },
            });
            replayRunId = fresh.id;
          } catch (err) {
            replayOutcomeKnown = false;
            swallow(`signals: requestless orphaned-steer replay for run ${runId}`, err);
          }
        }
      }
      if (!replayOutcomeKnown) continue;
      if (!replayRunId) {
        console.warn(
          `[signals] orphaned ${signal.kind} for terminal run ${runId} could not be replayed — dropped: ${signal.text?.slice(0, 120) ?? ""}`,
        );
      }
      await signals.acknowledge(runId, id);
      drained.push({ signal, ...(replayRunId ? { replayRunId } : {}) });
    }
    return drained;
  });
}

export function createAppHelpers(deps: AppDeps, app: App) {
  const adminLink = (sessionId: string): string | undefined =>
    deps.publicWebUrl ? adminSessionUrl(deps.publicWebUrl, sessionId) : undefined;
  const audit = (principalId: string, action: string, resource: string, scopeLabel: ScopeId): void =>
    deps.auditLog.record({ at: Date.now(), principalId, action, resource, scopeLabel });

  const surfaceContext = createSurfaceContextPuller(app);
  const directoryRefresher = createSurfaceContextPuller(app, { waitMs: 4_000 });
  const channelPrivacy = async (ref: string): Promise<boolean | undefined> =>
    deps.directory.channelPrivacy?.(ref).catch(reportFailureAs("api: channel privacy", undefined, ref));

  async function refreshSurfaceDirectory(): Promise<void> {
    await directoryRefresher.pull("slack", { syncDirectory: true, count: 1 });
  }
  const reachDir: ReachDirectory = {
    resolveRecipient: (q) => deps.directory.resolve(q),
    resolveChannel: (q) => deps.directory.resolveChannel(q),
    channelMember: (c, p) => deps.directory.channelMember(c, p),
    resolveGroup: (parts) => deps.directory.resolveGroupByParticipants(parts),
    groupMember: (g, p) => deps.directory.groupMember(g, p),
    directoryMember: (p) => deps.directory.get(p),
    openGroup: (parts) => openGroupViaSurface((query) => surfaceContext.pull("slack", query), parts),
    registerGroup: (g, parts) => deps.directory.upsertGroup(g, parts),
  };
  const resolveReachTargetFor = (
    target: ReachTarget,
    authorityId: string,
    opts?: ReachOpts,
  ): Promise<ReachResolution> => resolveReachTarget(reachDir, target, authorityId, opts);

  const { withAdminLink, drive } = createRunWaits(deps, adminLink);
  const scopes = createScopeAccess(deps, channelPrivacy);
  const {
    principalCanWriteScope,
    mayWriteSession,
    canContinueOnWeb,
    principalCanAccessCurrentScope,
    principalCanManageScope,
    membershipControlsScope,
    authorizesCapabilityScope,
    mayUseSharedScope,
    viewerMayUseRun,
  } = scopes;
  const {
    principalManagesArtifactHome,
    artifactAuthor,
    canManageSkill,
    republishIfShared,
    effectiveDeploymentPermission,
    artifactGrantPermission,
    principalCanReadDeployment,
    principalGitPermission,
  } = createArtifactAccess(deps, audit, scopes);
  const viewers = createViewerScopes(deps);
  const { projectView, projectsForViewer, viewableRows, sessionsForViewer, sessionForViewer } = viewers;
  const { contextsFor, filesForViewer, currentResourceScopesForViewer } = createViewerResources(deps, viewers);
  const {
    approvalRecordIsCurrent,
    approvalResumable,
    approvalVisibleToViewer,
    pendingApprovalForSession,
    pendingApprovalResultForThread,
  } = createApprovalAccess(deps, authorizesCapabilityScope, viewers);
  const { syncProjectChannelRoster, syncLinkedProjectRosters, reconcileProjectMember } = createProjectRosterSync(
    deps,
    audit,
  );

  return {
    audit,
    directoryMember: (principalId: string) => app.directoryMember(principalId),
    withAdminLink,
    resolveReachTargetFor,
    approvalRecordIsCurrent,
    approvalResumable,
    approvalVisibleToViewer,
    pendingApprovalForSession,
    pendingApprovalResultForThread,
    drive,
    mayUseSharedScope,
    viewerMayUseRun,
    projectView,
    projectsForViewer,
    viewableRows,
    sessionsForViewer,
    sessionForViewer,
    contextsFor,
    filesForViewer,
    currentResourceScopesForViewer,
    principalCanAccessCurrentScope,
    principalCanWriteScope,
    canContinueOnWeb,
    mayWriteSession,
    principalCanManageScope,
    membershipControlsScope,
    authorizesCapabilityScope,
    principalManagesArtifactHome,
    artifactAuthor,
    canManageSkill,
    republishIfShared,
    effectiveDeploymentPermission,
    artifactGrantPermission,
    principalCanReadDeployment,
    principalGitPermission,
    refreshSurfaceDirectory,
    reconcileProjectMember,
    syncProjectChannelRoster,
    syncLinkedProjectRosters,
    replayOrphanedRunSignals: (runId: string) => replayOrphanedRunSignals(deps, app, runId),
  };
}

export type AppHelpers = ReturnType<typeof createAppHelpers>;
