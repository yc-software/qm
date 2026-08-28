import type {
  PendingApproval,
  PendingApprovalRecord,
  Permission,
  Principal,
  ScopeId,
  Session,
  TurnResult,
} from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { isManageableCreationScope, parseScopeId, scopeId } from "../types.ts";
import { type ListOwnedOptions } from "../files/file-artifact-store.ts";
import type { Run } from "../runs/run-store.ts";
import type { RunSignal } from "../runs/run-signal-store.ts";
import { processRun } from "../runs/worker.ts";
import { deployRef, encodeRef, parseRef } from "../acl/resource-ref.ts";
import type { Skill } from "../skills/skill-store.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";
import {
  createCanReadScope,
  createCanManageScope,
  createCanWriteScope,
  createIsCurrentSharedScopeMember,
  createManagesArtifactHome,
  createMembershipControlsScope,
} from "../resolution/scope-membership.ts";
import { samePerson } from "../directory/person.ts";
import type { Deployment } from "../deploy/deploy-store.ts";
import { swallow } from "../util/errors.ts";
import {
  openGroupViaSurface,
  resolveReachTarget,
  type ReachOpts,
  type ReachResolution,
  type ReachTarget,
  type ReachDirectory,
} from "../reach/reach.ts";
import { createSurfaceContextPuller } from "./surface-context-puller.ts";
import {
  isProjectGroupRef,
  projectGroupRef,
  projectIdFromGroupRef,
  projectScopeId,
  type Project,
} from "../projects/project-store.ts";

import type { App, AppDeps, ContextSummary, ProjectView, FileListPage } from "./app-types.ts";
import { toFileItem } from "./app-types.ts";

export function createAppHelpers(deps: AppDeps, app: App) {
  const adminBase = deps.publicWebUrl?.replace(/\/$/, "");
  const adminLink = (sessionId: string): string | undefined =>
    adminBase ? `${adminBase}/admin/history?session=${encodeURIComponent(sessionId)}` : undefined;

  const surfaceContext = createSurfaceContextPuller(app);
  const directoryRefresher = createSurfaceContextPuller(app, { waitMs: 4_000 });

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

  async function approvalCurrentForSession(session: Session, record: PendingApprovalRecord): Promise<boolean> {
    const parsed = parseScopeId(session.scopeId);
    if (parsed.kind !== "group" || !isProjectGroupRef(parsed.ref)) return true;
    const requester = record.request?.actor.externalId;
    return (
      !!requester &&
      authorizesCapabilityScope({
        actorId: requester,
        scopeId: session.scopeId,
        scopeVersion: record.request?.scopeVersion,
      })
    );
  }

  async function approvalRecordIsCurrent(record: PendingApprovalRecord, knownSession?: Session): Promise<boolean> {
    const session = knownSession ?? (await deps.sessions.get(record.sessionId));
    return !!session && approvalCurrentForSession(session, record);
  }

  async function approvalVisibleToViewer(
    session: Session,
    viewer: string,
    record: PendingApprovalRecord,
  ): Promise<boolean> {
    if (record.request?.actor.externalId !== viewer) return false;
    if ((await managedProjectMembership(session.scopeId, viewer)) === false) return false;
    const parsed = parseScopeId(session.scopeId);
    if (parsed.kind !== "group" || !isProjectGroupRef(parsed.ref)) return true;
    if (!samePerson(record.request?.actor.externalId, viewer) || record.createdAt === undefined) return false;
    const window = (await deps.sessions.listParticipants()).find(
      (candidate) => candidate.sessionId === session.id && samePerson(candidate.principalId, viewer),
    );
    return (
      !!window && record.createdAt >= window.validFrom && (window.validTo === null || record.createdAt < window.validTo)
    );
  }

  async function pendingApprovalForSession(
    sessionId: string,
    opts: { blockingOnly: boolean; viewer?: string },
  ): Promise<PendingApproval[]> {
    if (!deps.approvals) return [];
    const [entries, session] = await Promise.all([deps.approvals.entries(), deps.sessions.get(sessionId)]);
    if (!session) return [];
    const candidates: Array<{ key: string; record: PendingApprovalRecord }> = [];
    for (const [key, record] of entries) {
      if (record.sessionId !== sessionId || (opts.blockingOnly && record.blocksInput === false)) continue;
      if (await approvalRecordIsCurrent(record, session)) candidates.push({ key, record });
    }
    const visible = opts.viewer
      ? (
          await Promise.all(
            candidates.map(async (candidate) => ({
              candidate,
              allowed: await approvalVisibleToViewer(session, opts.viewer!, candidate.record),
            })),
          )
        )
          .filter(({ allowed }) => allowed)
          .map(({ candidate }) => candidate)
      : candidates;
    return visible.map(({ key, record: r }) => ({
      requestId: key,
      command: r.command,
      reason: r.reason ?? "requires approval",
      ...(r.matched ? { matched: r.matched } : {}),
      ...(r.purpose ? { purpose: r.purpose } : {}),
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.summaryDetail ? { summaryDetail: r.summaryDetail } : {}),
      ...(r.grantModes ? { grantModes: r.grantModes } : {}),
      blocksInput: r.blocksInput !== false,
      ...(r.kind === "approval" ? { kind: r.kind } : {}),
    }));
  }

  async function pendingApprovalResultForThread(threadRef: string, viewer?: string): Promise<TurnResult | null> {
    const session = await deps.sessions.getByThread(threadRef);
    if (!session) return null;
    if (viewer && !(await sessionsForViewer(viewer)).some((candidate) => candidate.id === session.id)) return null;
    const all = viewer ? await pendingApprovalForSession(session.id, { blockingOnly: true }) : [];
    const approvals = await pendingApprovalForSession(session.id, {
      blockingOnly: true,
      ...(viewer ? { viewer } : {}),
    });
    if (!approvals.length) {
      return all.length
        ? {
            status: "pending_approval",
            sessionId: session.id,
            reason: "This conversation is waiting for another project member to resolve a pending approval.",
          }
        : null;
    }
    return {
      status: "pending_approval",
      sessionId: session.id,
      reason: "Approve or deny the pending command to continue.",
      pendingApprovals: approvals,
    };
  }

  async function drive(runId: string): Promise<TurnResult> {
    const claimed = await deps.runs.claimById(runId, "inline", deps.leaseTtlMs);
    if (claimed) {
      return withAdminLink(
        await processRun({ runs: deps.runs, orchestrator: deps.orchestrator, leaseTtlMs: deps.leaseTtlMs }, claimed),
      );
    }
    const finished = await deps.runs.waitFor(runId, deps.runWaitMs);
    return withAdminLink(
      finished.result ?? { status: "failed", sessionId: finished.sessionId, reason: "run produced no result" },
    );
  }

  async function mayUseSharedScope(kind: "channel" | "group", ref: string, actor: Principal): Promise<boolean> {
    if (!deps.identity.isInternal(actor)) return false;
    return principalCanAccessCurrentScope(actor.id, scopeId(kind, ref));
  }

  async function viewerMayUseRun(run: Run, viewer: string): Promise<boolean> {
    const conversation = run.request.conversation;
    if (conversation.kind === "dm") return samePerson(run.request.actor.id, viewer);
    if (!conversation.channelRef) return false;
    const scope = scopeId(conversation.kind, conversation.channelRef);
    if (await principalIsCurrentSharedScopeMember(viewer, scope)) {
      if (conversation.kind !== "group" || !isProjectGroupRef(conversation.channelRef)) return true;
      return run.request.scopeVersion === (await deps.projects?.version(conversation.channelRef));
    }
    if (conversation.kind !== "channel") return false;
    const isPublic = (await deps.directory.channelPrivacy?.(conversation.channelRef).catch(() => undefined)) === false;
    const active = deps.identity.isInternal(deps.identity.classify(viewer));
    return isPublic && active && principalCanReadScope(viewer, scope);
  }

  async function projectView(project: Project): Promise<ProjectView> {
    const memberIds = (await deps.projects?.members(projectGroupRef(project.id))) ?? project.memberIds;
    const manual = new Set([project.ownerId, ...project.memberIds]);
    const members = await Promise.all(
      memberIds.map(async (principalId) => {
        const member = await deps.directory.get(principalId).catch(() => null);
        return {
          principalId,
          displayName: member?.displayName?.trim() || principalId,
          ...(manual.has(principalId) ? {} : { viaChannel: true }),
        };
      }),
    );
    return { ...project, memberIds, scopeId: projectScopeId(project.id), members };
  }

  async function projectsForViewer(principalId: string): Promise<ProjectView[]> {
    if (!deps.projects || !deps.identity.isInternal(deps.identity.classify(principalId))) return [];
    const projects = (await deps.projects.listForMember(principalId)).filter((project) =>
      deps.identity.isInternal(deps.identity.classify(project.ownerId)),
    );
    return Promise.all(projects.map(projectView));
  }

  async function managedProjectMembership(scope: ScopeId, principalId: string): Promise<boolean | undefined> {
    const { kind, ref } = parseScopeId(scope);
    if (kind !== "group" || projectIdFromGroupRef(ref) === null) return undefined;
    if (!deps.projects) return false;
    const project = await deps.projects.get(projectIdFromGroupRef(ref)!);
    if (!project || project.orgId !== orgIdOf()) return false;
    if (!deps.identity.isInternal(deps.identity.classify(project.ownerId))) return false;
    if (!deps.identity.isInternal(deps.identity.classify(principalId))) return false;
    return (await deps.projects.membership(ref, principalId).catch(() => false)) === true;
  }

  async function sessionsForViewer(principalId: string): Promise<Session[]> {
    const sessions = await deps.sessions.listByParticipant(principalId);
    const allowed = await Promise.all(
      sessions.map((session) => managedProjectMembership(session.scopeId, principalId)),
    );
    return sessions.filter((_session, index) => allowed[index] !== false);
  }

  async function contextsFor(principalId: string): Promise<ContextSummary[]> {
    const personal = scopeId("personal", principalId);
    const byScope = new Map<ScopeId, ContextSummary>();
    byScope.set(personal, { scopeId: personal, kind: "personal", name: null, sessionCount: 0, lastActivityAt: null });
    if (deps.identity.isInternal(deps.identity.classify(principalId))) {
      for (const c of await deps.directory.listChannelsFor(principalId)) {
        const sid = scopeId("channel", c.channelId);
        byScope.set(sid, {
          scopeId: sid,
          kind: "channel",
          name: c.name,
          ...(c.isPrivate !== undefined ? { isPrivate: c.isPrivate } : {}),
          sessionCount: 0,
          lastActivityAt: null,
        });
      }
    }
    for (const project of await projectsForViewer(principalId)) {
      const sid = projectScopeId(project.id);
      byScope.set(sid, {
        scopeId: sid,
        kind: "group",
        name: project.name,
        sessionCount: 0,
        lastActivityAt: null,
        project,
      });
    }
    for (const s of await sessionsForViewer(principalId)) {
      const { kind } = parseScopeId(s.scopeId);
      if (s.scopeId !== personal && kind !== "channel" && kind !== "group") continue;
      let ctx = byScope.get(s.scopeId);
      if (!ctx && kind === "group" && (await deps.directory.groupMember(parseScopeId(s.scopeId).ref, principalId))) {
        ctx = { scopeId: s.scopeId, kind: "group", name: s.channelName ?? null, sessionCount: 0, lastActivityAt: null };
      }
      if (!ctx) continue;
      if (!ctx.name && s.channelName) ctx.name = s.channelName;
      if (s.hasEntries !== false || Boolean(s.title?.trim())) {
        ctx.sessionCount++;
        ctx.lastActivityAt = Math.max(ctx.lastActivityAt ?? 0, s.lastActivityAt ?? s.createdAt);
      }
      byScope.set(s.scopeId, ctx);
    }
    return [...byScope.values()].sort((a, b) => {
      if (a.kind === "personal") return -1;
      if (b.kind === "personal") return 1;
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    });
  }

  async function filesForViewer(
    principalId: string,
    opts?: ListOwnedOptions,
    inScope?: ScopeId,
  ): Promise<FileListPage> {
    const myScopes = await currentResourceScopesForViewer(principalId);
    const owned = await deps.files.listOwnedByScopes(myScopes, {
      ...opts,
      ...(inScope ? { createdInScope: inScope } : {}),
    });
    const handles = await deps.acl.handlesFor(myScopes);
    const refs = handles.map((h) => ({ ownerScopeId: h.ownerScopeId, path: h.ownerPath }));
    const sharedRows = await deps.files.resolveByOwnerPaths(refs);
    const shared = sharedRows
      .filter((f) => !myScopes.includes(f.ownerScopeId) && (!inScope || f.createdInScope === inScope))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      owned: owned.files.map(toFileItem),
      shared: shared.map(toFileItem),
      ...(owned.nextCursor ? { nextCursor: owned.nextCursor } : {}),
    };
  }

  async function currentResourceScopesForViewer(principalId: string): Promise<ScopeId[]> {
    const actor = deps.identity?.classify(principalId);
    if (actor && !deps.identity?.isInternal(actor)) return [];
    const scopes = new Set<ScopeId>([
      scopeId("personal", principalId),
      ...(actor?.teamIds ?? []).map((teamId) => scopeId("team", teamId)),
      scopeId("org", orgIdOf()),
    ]);
    try {
      const [sessions, channels, groups, projects] = await Promise.all([
        deps.sessions ? sessionsForViewer(principalId) : Promise.resolve([]),
        deps.directory ? deps.directory.listChannelsFor(principalId) : Promise.resolve([]),
        deps.directory?.listGroupsFor?.(principalId) ?? Promise.resolve([]),
        projectsForViewer(principalId),
      ]);
      const historical = new Set(sessions.map((session) => session.scopeId));
      for (const channel of channels) {
        const scope = scopeId("channel", channel.channelId);
        if (channel.isPrivate === true || historical.has(scope)) scopes.add(scope);
      }
      for (const groupId of groups) scopes.add(scopeId("group", groupId));
      for (const project of projects) scopes.add(project.scopeId);
    } catch (error) {
      void error;
    }
    return [...scopes];
  }

  async function canUseContext(principalId: string, targetScope: ScopeId): Promise<boolean> {
    return principalCanAccessCurrentScope(principalId, targetScope);
  }

  const scopeMembershipDeps = {
    ...(deps.projects ? { managedGroups: deps.projects } : {}),
    ...(deps.directory ? { directory: deps.directory } : {}),
    ...(deps.identity ? { identity: deps.identity } : {}),
  };

  const principalCanReadScope = createCanReadScope(scopeMembershipDeps);

  const principalCanWriteScope = createCanWriteScope(scopeMembershipDeps);

  async function principalCanAccessCurrentScope(principalId: string, targetScope: ScopeId): Promise<boolean> {
    if (await principalCanWriteScope(principalId, targetScope)) return true;
    const { kind, ref } = parseScopeId(targetScope);
    if (kind !== "channel") return false;
    if (!deps.identity.isInternal(deps.identity.classify(principalId))) return false;
    if ((await deps.directory.channelPrivacy?.(ref).catch(() => undefined)) !== false) return false;
    return principalCanReadScope(principalId, targetScope);
  }

  async function principalCanUseWriteGrant(principalId: string, targetScope: ScopeId): Promise<boolean> {
    const { kind, ref } = parseScopeId(targetScope);
    const publicChannel =
      kind === "channel" && (await deps.directory.channelPrivacy?.(ref).catch(() => undefined)) === false;
    return publicChannel
      ? principalCanAccessCurrentScope(principalId, targetScope)
      : principalCanWriteScope(principalId, targetScope);
  }

  const principalIsCurrentSharedScopeMember = createIsCurrentSharedScopeMember(scopeMembershipDeps);

  const principalCanManageScope = createCanManageScope(scopeMembershipDeps);
  const membershipControlsScope = createMembershipControlsScope(scopeMembershipDeps);

  async function authorizesCapabilityScope(
    claims: Pick<CapabilityClaims, "actorId" | "scopeId" | "scopeVersion" | "botActor" | "liveActor" | "members">,
  ): Promise<boolean> {
    const { kind, ref } = parseScopeId(claims.scopeId);
    if (kind === "channel" && !deps.identity.isInternal(deps.identity.classify(claims.actorId))) return false;
    const privateChannel =
      kind === "channel" && (await deps.directory.channelPrivacy?.(ref).catch(() => undefined)) === true;
    const capabilityMembership = privateChannel
      ? await deps.directory.channelMembership(ref, claims.actorId).catch(() => undefined)
      : undefined;
    const attestedBot =
      privateChannel &&
      claims.botActor === true &&
      claims.liveActor === true &&
      claims.members?.some((member) => member.id === claims.actorId && member.type === "internal") === true;
    if (
      (kind === "channel" &&
        !(
          attestedBot ||
          (capabilityMembership ?? (await principalCanAccessCurrentScope(claims.actorId, claims.scopeId)))
        )) ||
      (kind === "group" && !(await principalCanWriteScope(claims.actorId, claims.scopeId)))
    ) {
      return false;
    }
    if (kind !== "group" || deps.projects?.recognizes(ref) !== true) return true;
    return (
      (await principalCanManageScope(claims.actorId, claims.scopeId)) &&
      claims.scopeVersion === (await deps.projects.version(ref))
    );
  }

  const principalManagesArtifactHome = createManagesArtifactHome(scopeMembershipDeps, principalCanManageScope);

  async function artifactAuthor(ownerScopeId: ScopeId, ref: string): Promise<string | undefined> {
    const { kind } = parseScopeId(ownerScopeId);
    if (kind !== "channel" && kind !== "group") return undefined;
    const r = parseRef(ref);
    if (r.kind === "skill") return (await deps.skills.get(r.id))?.createdBy;
    if (r.kind === "cron") return (await deps.crons.get(r.id))?.createdBy;
    if (r.kind === "deploy") return (await deps.deploy.listDeployments()).find((d) => d.id === r.id)?.createdBy;
    if (r.kind === "file") return (await deps.files.resolveByOwnerPaths([{ ownerScopeId, path: r.id }]))[0]?.createdBy;
    return undefined;
  }

  function canManageSkill(skill: Skill, principalId: string): Promise<boolean> {
    return principalManagesArtifactHome(skill.scopeId, skill.createdBy, principalId);
  }

  async function republishIfShared(skill: Skill, editorId: string): Promise<Skill> {
    if (skill.status === "published") return skill;
    const { kind } = parseScopeId(skill.scopeId);
    if (kind !== "channel" && kind !== "group") return skill;
    await deps.skills.review(skill.id, "system:skill-authoring", skill.manifest.requiredCapabilities);
    const published = await deps.skills.publish(skill.id);
    deps.auditLog.record({
      at: Date.now(),
      principalId: editorId,
      action: "skill_review",
      resource: skill.id,
      scopeLabel: skill.scopeId,
    });
    return published;
  }

  async function effectiveDeploymentPermission(d: Deployment, principalId: string): Promise<Permission | null> {
    if (!principalId) return null;
    if (await principalCanWriteScope(principalId, d.ownerScopeId)) return "write";
    let best: Permission | null = (await principalCanAccessCurrentScope(principalId, d.ownerScopeId)) ? "read" : null;
    const grants = (await deps.acl?.grantsFor(d.ownerScopeId, encodeRef(deployRef(d.id))).catch(() => [])) ?? [];
    for (const g of grants) {
      if (g.permission !== "read" && g.permission !== "write") continue;
      if (!(await principalCanAccessCurrentScope(principalId, g.granteeScopeId))) continue;
      if (g.permission === "write" && (await principalCanUseWriteGrant(principalId, g.granteeScopeId))) return "write";
      best = "read";
    }
    return best;
  }

  async function principalCanReadDeployment(d: Deployment, principalId: string): Promise<boolean> {
    return (await effectiveDeploymentPermission(d, principalId)) != null;
  }

  async function principalGitPermission(d: Deployment, principalId: string): Promise<"read" | "write" | null> {
    if (!principalId) return null;
    const { kind } = parseScopeId(d.ownerScopeId);
    if (await principalManagesArtifactHome(d.ownerScopeId, d.createdBy, principalId)) return "write";
    if (isManageableCreationScope(d.createdInScope) && (await principalCanWriteScope(principalId, d.createdInScope!)))
      return "write";
    let canRead = kind === "org" && (await principalCanAccessCurrentScope(principalId, d.ownerScopeId));
    const grants = (await deps.acl?.grantsFor(d.ownerScopeId, encodeRef(deployRef(d.id))).catch(() => [])) ?? [];
    for (const g of grants) {
      if (g.permission !== "read" && g.permission !== "write") continue;
      if (!(await principalCanAccessCurrentScope(principalId, g.granteeScopeId))) continue;
      if (g.permission === "write" && (await principalCanUseWriteGrant(principalId, g.granteeScopeId))) return "write";
      canRead = true;
    }
    if (canRead) return "read";
    return (await principalCanAccessCurrentScope(principalId, d.ownerScopeId)) ? "read" : null;
  }

  async function syncProjectChannelRoster(project: Project, actorId: string): Promise<void> {
    const link = project.slackChannel;
    if (!link || !deps.projects) return;
    const roster = await deps.directory.channelMemberIds(link.channelId).catch(() => undefined);
    if (roster === undefined) return;
    const derived = roster.filter((m) => deps.identity.isInternal(deps.identity.classify(m)));
    const channel = (await deps.directory.listChannels().catch(() => [])).find((c) => c.channelId === link.channelId);
    const prev = project.channelMemberIds ?? [];
    const manual = new Set([project.ownerId, ...project.memberIds]);
    const prevSet = new Set(prev);
    const nextSet = new Set(derived);
    await deps.projects.syncChannelMembers(project.id, derived, channel?.name, async ({ project: p, changed }) => {
      if (!changed) return;
      for (const m of derived) {
        if (prevSet.has(m) || manual.has(m)) continue;
        deps.auditLog.record({
          at: Date.now(),
          principalId: actorId,
          action: "project.member.add",
          resource: m,
          scopeLabel: projectScopeId(p.id),
        });
        await reconcileProjectMember(p, m, true);
      }
      for (const m of prev) {
        if (nextSet.has(m) || manual.has(m)) continue;
        deps.auditLog.record({
          at: Date.now(),
          principalId: actorId,
          action: "project.member.remove",
          resource: m,
          scopeLabel: projectScopeId(p.id),
        });
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
    const sessions = (await deps.sessions.listAll()).filter(
      (session) => session.scopeId === projectScopeId(project.id),
    );
    for (const session of sessions) {
      if (add) await deps.sessions.addParticipant(session.id, memberId, undefined, { includeHistory: true });
      else await deps.sessions.removeParticipant(session.id, memberId);
    }
  }

  async function replayOrphanedRunSignals(runId: string): Promise<Array<{ signal: RunSignal; replayRunId?: string }>> {
    if (!deps.signals) return [];
    const drained: Array<{ signal: RunSignal; replayRunId?: string }> = [];
    for (const signal of await deps.signals.takePending(runId)) {
      if (signal.kind === "abort") continue;
      if (!signal.request) {
        // A steer sent through /v1/runs/:id/signal carries no TurnRequest. Its text is
        // still a real user message — re-enqueue it on the run's own request instead of
        // dropping it, so a steer that raced the run's end is never silently lost.
        const orphanRun = signal.text?.trim() ? await deps.runs.get(runId) : null;
        if (orphanRun) {
          try {
            const { displayText: _d, attachments: _a, approval: _ap, ...base } = orphanRun.request;
            const { run: fresh } = await deps.runs.enqueue({
              sessionId: orphanRun.sessionId,
              request: { ...base, text: signal.text! },
            });
            drained.push({ signal, replayRunId: fresh.id });
            continue;
          } catch (err) {
            swallow(`signals: requestless orphaned-steer replay for run ${runId}`, err);
          }
        }
        console.warn(
          `[signals] orphaned ${signal.kind} for terminal run ${runId} has no stored request — dropped: ${signal.text?.slice(0, 120) ?? ""}`,
        );
        drained.push({ signal });
        continue;
      }
      try {
        const replayed = await app.turn({ ...signal.request, async: true });
        drained.push({ signal, ...(replayed.runId ? { replayRunId: replayed.runId } : {}) });
      } catch (err) {
        swallow(`signals: orphaned-signal replay for run ${runId}`, err);
        drained.push({ signal });
      }
    }
    return drained;
  }

  return {
    adminBase,
    adminLink,
    withAdminLink,
    resolveReachTargetFor,
    approvalRecordIsCurrent,
    approvalVisibleToViewer,
    pendingApprovalForSession,
    pendingApprovalResultForThread,
    drive,
    mayUseSharedScope,
    viewerMayUseRun,
    projectView,
    projectsForViewer,
    managedProjectMembership,
    sessionsForViewer,
    contextsFor,
    filesForViewer,
    currentResourceScopesForViewer,
    canUseContext,
    principalCanAccessCurrentScope,
    principalCanManageScope,
    membershipControlsScope,
    authorizesCapabilityScope,
    principalManagesArtifactHome,
    artifactAuthor,
    canManageSkill,
    republishIfShared,
    effectiveDeploymentPermission,
    principalCanReadDeployment,
    principalGitPermission,
    refreshSurfaceDirectory,
    reconcileProjectMember,
    syncProjectChannelRoster,
    syncLinkedProjectRosters,
    replayOrphanedRunSignals,
  };
}

export type AppHelpers = ReturnType<typeof createAppHelpers>;
