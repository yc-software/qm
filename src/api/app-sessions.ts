import type { PendingApprovalRecord } from "../types.ts";
import { orgId as orgIdOf } from "../config.ts";
import { parseScopeId, scopeId } from "../types.ts";
import { fileArtifactId } from "../files/file-artifact-store.ts";
import { transcriptEntries, windowedTranscript } from "../sessions/session-store.ts";
import { SEARCH_HIT_LIMIT, searchSnippet, searchTerms } from "../sessions/entry-search.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import { processIsGone } from "../sandbox/process-poll.ts";
import { cronRef, deployRef, encodeRef, fileRef, skillRef } from "../acl/resource-ref.ts";
import { samePerson } from "../directory/person.ts";
import { AdminError } from "../admin/admin-service.ts";
import { type ArtifactHome } from "./artifact-share.ts";
import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES, mimeFromName, safeAttachmentName } from "../core/attachments.ts";
import { projectIdFromGroupRef, projectScopeId } from "../projects/project-store.ts";

import type { App, AppDeps } from "./app-types.ts";
import { toFileItem, type ScopeDeployment, type SessionSearchHit } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

export function createSessionMethods(
  deps: AppDeps,
  h: AppHelpers,
): Pick<
  App,
  | "getSession"
  | "getSessionForViewer"
  | "getSessionEntryForViewer"
  | "listFilesForViewer"
  | "uploadFileForViewer"
  | "openFileForViewer"
  | "listSessions"
  | "searchSessions"
  | "sessionBackground"
  | "readSessionBackgroundOutput"
  | "listContexts"
  | "listProjects"
  | "createProject"
  | "addProjectMember"
  | "removeProjectMember"
  | "renameProject"
  | "setProjectSlackChannel"
  | "listScopeResources"
  | "managesScope"
  | "membershipControlsScope"
  | "authorizesCapabilityScope"
  | "updateSession"
  | "regenerateTitle"
  | "spawnSession"
  | "discardSession"
  | "forkSession"
  | "grant"
  | "revokeGrant"
  | "promoteSkill"
  | "belongsToScope"
  | "canManageArtifactHome"
  | "getArtifactHome"
  | "moveArtifactHome"
  | "getSoul"
  | "updateSoul"
> {
  const {
    sessionsForViewer,
    filesForViewer,
    canUseContext,
    currentResourceScopesForViewer,
    contextsFor,
    projectsForViewer,
    projectView,
    reconcileProjectMember,
    syncProjectChannelRoster,
    managedProjectMembership,
    approvalRecordIsCurrent,
    principalCanAccessCurrentScope,
    principalGitPermission,
    principalCanManageScope,
    membershipControlsScope,
    authorizesCapabilityScope,
    principalManagesArtifactHome,
    artifactAuthor,
  } = h;
  return {
    async getSession(sessionId, window) {
      const session = await deps.sessions.get(sessionId);
      if (!session) return null;
      const w = windowedTranscript(transcriptEntries(await deps.sessions.getEntries(sessionId)), window);
      return { session, entries: w.entries, ...(w.earlier > 0 ? { earlierEntries: w.earlier } : {}) };
    },

    async getSessionForViewer(sessionId, principalId, window) {
      const session = (await sessionsForViewer(principalId)).find((s) => s.id === sessionId);
      if (!session) return null;
      const w = windowedTranscript(
        transcriptEntries(await deps.sessions.visibleEntries(sessionId, principalId)),
        window,
      );
      return { session, entries: w.entries, ...(w.earlier > 0 ? { earlierEntries: w.earlier } : {}) };
    },

    async getSessionEntryForViewer(sessionId, principalId, seq) {
      const session = (await sessionsForViewer(principalId)).find((s) => s.id === sessionId);
      if (!session) return null;
      const entry = transcriptEntries(await deps.sessions.visibleEntries(sessionId, principalId)).find(
        (e) => e.seq === seq,
      );
      return entry ? { entry } : null;
    },

    listFilesForViewer(principalId, opts, inScope) {
      return filesForViewer(principalId, opts, inScope);
    },

    async uploadFileForViewer(principalId, input) {
      const ownerScopeId = scopeId("personal", principalId);
      const createdInScope = input.scopeId ?? ownerScopeId;
      if (!(await canUseContext(principalId, createdInScope))) return null;
      const name = safeAttachmentName(input.name);
      const mimetype = (input.mimetype ?? mimeFromName(name)).split(";")[0]!.trim().toLowerCase() || mimeFromName(name);
      const id = fileArtifactId(`upload:${principalId}:${createdInScope}:${Date.now()}:${randomUUID()}`, "in", 0);
      const path = `artifacts/${id}/${name}`;
      const { artifact } = await deps.files.put({
        id,
        ownerScopeId,
        createdBy: principalId,
        name,
        path,
        mimetype,
        data: input.data,
        direction: "in",
        createdInScope,
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      if (createdInScope !== ownerScopeId) {
        await deps.acl.grant({
          ownerScopeId,
          ref: path,
          granteeScopeId: createdInScope,
          permission: "read",
          grantedBy: principalId,
        });
      }
      deps.auditLog?.record({
        at: Date.now(),
        principalId,
        action: "file.upload",
        resource: path,
        scopeLabel: createdInScope,
      });
      return toFileItem(artifact);
    },

    async openFileForViewer(id, principalId) {
      const art = await deps.files.get(id);
      if (!art) return null;
      const myScopes = await currentResourceScopesForViewer(principalId);
      let allowed = myScopes.includes(art.ownerScopeId);
      if (!allowed) {
        const grants = await deps.acl.grantsFor(art.ownerScopeId, art.path);
        allowed = grants.some((g) => myScopes.includes(g.granteeScopeId));
      }
      if (!allowed) return null;
      const opened = await deps.files.open(id);
      if (!opened) return null;
      return { name: art.name, mimetype: art.mimetype, sizeBytes: opened.sizeBytes, stream: opened.stream };
    },

    async listSessions(principalId) {
      const workingThreadRefs = new Set(await deps.runs.activeSessionIds());
      const all = await sessionsForViewer(principalId);
      const visibleById = new Map(all.map((session) => [session.id, session]));
      const approvalRows: PendingApprovalRecord[] = [];
      for (const [, record] of (await deps.approvals?.entries()) ?? []) {
        const session = visibleById.get(record.sessionId);
        if (session && (await approvalRecordIsCurrent(record, session))) approvalRows.push(record);
      }
      const waiting = new Set(approvalRows.filter((r) => r.blocksInput !== false).map((r) => r.sessionId));
      const sessions = all.filter(
        (s) =>
          s.hasEntries !== false || Boolean(s.title?.trim()) || workingThreadRefs.has(s.threadRef) || waiting.has(s.id),
      );
      const now = Date.now();
      const jobCounts = new Map<string, number>();
      for (const rec of (await deps.processes?.listLive(now)) ?? []) {
        if (rec.kind !== "background" || !rec.sessionRef) continue;
        jobCounts.set(rec.sessionRef, (jobCounts.get(rec.sessionRef) ?? 0) + 1);
      }
      const watchCounts = new Map<string, number>();
      for (const m of (await deps.monitors?.enabled()) ?? []) {
        if (m.expiresAt <= now) continue;
        watchCounts.set(m.threadRef, (watchCounts.get(m.threadRef) ?? 0) + 1);
      }
      const cronCounts = new Map<string, number>();
      for (const c of await deps.crons.list()) {
        if (!c.enabled || c.archived || !c.destination) continue;
        cronCounts.set(c.destination.target, (cronCounts.get(c.destination.target) ?? 0) + 1);
      }
      if (
        workingThreadRefs.size === 0 &&
        waiting.size === 0 &&
        jobCounts.size === 0 &&
        watchCounts.size === 0 &&
        cronCounts.size === 0
      )
        return sessions;
      return sessions.map((s) => ({
        ...s,
        ...(workingThreadRefs.has(s.threadRef) ? { working: true } : {}),
        ...(waiting.has(s.id) ? { awaitingInput: true } : {}),
        ...(jobCounts.has(s.threadRef) ? { backgroundJobs: jobCounts.get(s.threadRef)! } : {}),
        ...(watchCounts.has(s.threadRef) ? { watches: watchCounts.get(s.threadRef)! } : {}),
        ...(cronCounts.has(s.threadRef) ? { crons: cronCounts.get(s.threadRef)! } : {}),
      }));
    },

    async searchSessions(principalId, query, limit = SEARCH_HIT_LIMIT): Promise<SessionSearchHit[]> {
      const capped = Math.max(1, Math.min(limit, 100));
      const hits = await deps.sessions.searchEntries(principalId, query, capped);
      if (!hits.length) return [];
      const visible = new Map((await sessionsForViewer(principalId)).map((s) => [s.id, s]));
      const terms = searchTerms(query);
      return hits.flatMap((hit) => {
        const session = visible.get(hit.sessionId);
        if (!session) return [];
        return [
          {
            sessionId: hit.sessionId,
            title: session.title ?? null,
            scopeId: session.scopeId,
            ...(session.channelName ? { channelName: session.channelName } : {}),
            ...(session.surface ? { surface: session.surface } : {}),
            seq: hit.seq,
            entryType: hit.type,
            ...(hit.author ? { author: hit.author } : {}),
            snippet: searchSnippet(hit.text, terms),
            createdAt: hit.createdAt,
          },
        ];
      });
    },

    async sessionBackground(sessionId, viewer) {
      const session = (await sessionsForViewer(viewer)).find((s) => s.id === sessionId);
      if (!session) return null;
      const now = Date.now();
      const jobs = ((await deps.processes?.listLive(now)) ?? [])
        .filter((r) => r.kind === "background" && r.sessionRef === session.threadRef)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((r) => ({ processId: r.processId, command: r.command, startedAt: r.startedAt, expiresAt: r.expiresAt }));
      const watches = ((await deps.monitors?.enabled()) ?? [])
        .filter((m) => m.threadRef === session.threadRef && m.expiresAt > now)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((m) => ({
          id: m.id,
          processId: m.processId,
          command: m.command,
          ...(m.pattern !== undefined ? { pattern: m.pattern } : {}),
          ...(m.instructions !== undefined ? { instructions: m.instructions } : {}),
          createdAt: m.createdAt,
          expiresAt: m.expiresAt,
          ...(m.lastFiredAt !== undefined ? { lastFiredAt: m.lastFiredAt } : {}),
        }));
      const crons = (await deps.crons.list())
        .filter((c) => c.enabled && !c.archived && c.destination?.target === session.threadRef)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((c) => ({
          id: c.id,
          ...(c.title !== undefined ? { title: c.title } : {}),
          ...(c.nextFireAt !== undefined ? { nextFireAt: c.nextFireAt } : {}),
        }));
      return { jobs, watches, crons };
    },

    async readSessionBackgroundOutput(sessionId, processId, viewer, sinceCursor) {
      const session = (await sessionsForViewer(viewer)).find((s) => s.id === sessionId);
      if (!session || !deps.processes || !deps.sandbox || !supportsProcessSessions(deps.sandbox)) return null;
      const sandbox = deps.sandbox;
      const rec = await deps.processes.get(processId);
      if (!rec || rec.kind !== "background" || rec.sessionRef !== session.threadRef) return null;
      const handle = await sandbox.provision([{ scopeId: rec.scopeId, mode: "rw", mountPath: "" }]);
      try {
        const read = await sandbox.readProcess(handle, processId, { sinceCursor, maxBytes: 65_536, waitMs: 0 });
        return {
          chunk: read.chunks,
          cursor: read.cursor,
          state: read.status.state,
          ...(read.status.state === "exited" ? { exitCode: read.status.code } : {}),
        };
      } catch (e) {
        if (processIsGone(e)) return { chunk: "", cursor: sinceCursor, state: "exited" };
        throw e;
      } finally {
        await sandbox.teardown(handle, { keepWarm: true }).catch(() => {});
      }
    },

    listContexts(principalId) {
      return contextsFor(principalId);
    },

    async listProjects(principalId) {
      return projectsForViewer(principalId);
    },

    async createProject(principalId, name) {
      const principal = deps.identity.classify(principalId);
      if (!deps.projects || !deps.identity.isInternal(principal) || !name.trim()) return null;
      const project = await deps.projects.create({ name, ownerId: principalId });
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "project.create",
        resource: project.id,
        scopeLabel: projectScopeId(project.id),
      });
      return projectView(project);
    },

    async addProjectMember(id, principalId, memberId) {
      if (!deps.projects) return { status: "not_found" };
      if (!deps.identity.isInternal(deps.identity.classify(principalId))) return { status: "forbidden" };
      const existing = await deps.projects.get(id);
      if (!existing || existing.orgId !== orgIdOf()) return { status: "not_found" };
      const directoryMember = await deps.directory.get(memberId);
      const principal = deps.identity.classify(memberId);
      if (!directoryMember || directoryMember.type !== "internal" || !deps.identity.isInternal(principal))
        return { status: "invalid_member" };
      const result = await deps.projects.addMember(id, principalId, memberId, async ({ project, changed }) => {
        if (changed)
          deps.auditLog.record({
            at: Date.now(),
            principalId,
            action: "project.member.add",
            resource: memberId,
            scopeLabel: projectScopeId(project.id),
          });
        await reconcileProjectMember(project, memberId, true);
      });
      if (result.status === "ok") {
        return { ...result, project: await projectView(result.project) };
      }
      return result;
    },

    async removeProjectMember(id, principalId, memberId) {
      if (!deps.projects) return { status: "not_found" };
      if (!deps.identity.isInternal(deps.identity.classify(principalId))) return { status: "forbidden" };
      const existing = await deps.projects.get(id);
      if (!existing || existing.orgId !== orgIdOf()) return { status: "not_found" };
      const result = await deps.projects.removeMember(id, principalId, memberId, async ({ project, changed }) => {
        if (changed)
          deps.auditLog.record({
            at: Date.now(),
            principalId,
            action: "project.member.remove",
            resource: memberId,
            scopeLabel: projectScopeId(project.id),
          });
        await reconcileProjectMember(project, memberId, false);
      });
      if (result.status === "ok") {
        return { ...result, project: await projectView(result.project) };
      }
      return result;
    },

    async setProjectSlackChannel(id, principalId, channel) {
      if (!deps.projects) return { status: "not_found" };
      if (!deps.identity.isInternal(deps.identity.classify(principalId))) return { status: "forbidden" };
      const existing = await deps.projects.get(id);
      if (!existing || existing.orgId !== orgIdOf()) return { status: "not_found" };
      let link: { channelId: string; channelName: string } | null = null;
      if (channel !== null) {
        const wanted = channel.trim().replace(/^#/, "");
        if (!wanted) return { status: "invalid_channel" };
        const findChannel = async () => {
          const reachable = await deps.directory.listChannelsFor(principalId).catch(() => []);
          return (
            reachable.find((c) => c.channelId === wanted) ??
            reachable.find((c) => c.name.toLowerCase() === wanted.toLowerCase())
          );
        };
        let match = await findChannel();
        if (!match) {
          // The synced directory may not have caught up with a just-created channel;
          // ask the surface for a fresh sync and look once more before giving up.
          await h.refreshSurfaceDirectory().catch(() => undefined);
          match = await findChannel();
        }
        if (!match) return { status: "invalid_channel" };
        const channelScope = scopeId("channel", match.channelId);
        const inUse = (await deps.sessions.listAll()).some((session) => session.scopeId === channelScope);
        if (inUse) return { status: "channel_in_use" };
        link = { channelId: match.channelId, channelName: match.name };
      }
      const prevDerived = existing.channelMemberIds ?? [];
      const manual = new Set([existing.ownerId, ...existing.memberIds]);
      const result = await deps.projects.setSlackChannel(id, principalId, link, async ({ project, changed }) => {
        if (changed)
          deps.auditLog.record({
            at: Date.now(),
            principalId,
            action: link ? "project.slack_channel.link" : "project.slack_channel.unlink",
            resource: link?.channelId ?? existing.slackChannel?.channelId ?? "",
            scopeLabel: projectScopeId(project.id),
          });
        if (!link) {
          for (const m of prevDerived) {
            if (manual.has(m)) continue;
            deps.auditLog.record({
              at: Date.now(),
              principalId,
              action: "project.member.remove",
              resource: m,
              scopeLabel: projectScopeId(project.id),
            });
            await reconcileProjectMember(project, m, false);
          }
        }
      });
      if (result.status !== "ok") return result;
      if (link) await syncProjectChannelRoster(result.project, principalId);
      const fresh = (await deps.projects.get(id)) ?? result.project;
      return { ...result, project: await projectView(fresh) };
    },

    async renameProject(id, principalId, name) {
      if (!deps.projects) return { status: "not_found" };
      if (!deps.identity.isInternal(deps.identity.classify(principalId))) return { status: "forbidden" };
      const existing = await deps.projects.get(id);
      if (!existing || existing.orgId !== orgIdOf()) return { status: "not_found" };
      const result = await deps.projects.rename(id, principalId, name, async ({ project, changed }) => {
        if (changed)
          deps.auditLog.record({
            at: Date.now(),
            principalId,
            action: "project.rename",
            resource: project.id,
            scopeLabel: projectScopeId(project.id),
          });
      });
      if (result.status === "ok") {
        return { ...result, project: await projectView(result.project) };
      }
      return result;
    },

    async listScopeResources(principalId, scope) {
      if (!(await principalCanAccessCurrentScope(principalId, scope))) return null;
      const [page, allCrons, allDeployments, allSkills] = await Promise.all([
        filesForViewer(principalId, undefined, scope),
        deps.crons.list(),
        deps.deploy.listDeployments(),
        deps.skills.list(),
      ]);
      const files = [...page.owned, ...page.shared].sort((a, b) => b.createdAt - a.createdAt);
      const deployments = (
        await Promise.all(
          allDeployments
            .filter((d) => d.createdInScope === scope || d.ownerScopeId === scope)
            .map(async (d): Promise<ScopeDeployment | null> => {
              const permission = await principalGitPermission(d, principalId);
              return permission
                ? {
                    id: d.id,
                    name: d.displayName ?? d.name ?? d.id,
                    status: d.status,
                    permission,
                    currentVersion: d.currentVersion,
                  }
                : null;
            }),
        )
      ).filter((d): d is ScopeDeployment => d != null);
      const skills = allSkills
        .filter((s) => s.scopeId === scope)
        .map((s) => ({ id: s.id, name: s.manifest.name, description: s.manifest.description, status: s.status }));
      return {
        files,
        crons: allCrons.filter((c) => c.ownerScopeId === scope),
        deployments,
        skills,
        manageable: await principalCanManageScope(principalId, scope),
      };
    },

    managesScope(principalId, scope) {
      return principalCanManageScope(principalId, scope);
    },

    membershipControlsScope(scope) {
      return membershipControlsScope(scope);
    },

    async authorizesCapabilityScope(claims) {
      return authorizesCapabilityScope(claims);
    },

    async updateSession(sessionId, principalId, patch) {
      const before = await sessionsForViewer(principalId);
      if (!before.some((s) => s.id === sessionId)) return null;
      await deps.sessions.updateParticipantView(sessionId, principalId, patch);
      const after = await sessionsForViewer(principalId);
      return after.find((s) => s.id === sessionId) ?? null;
    },

    async regenerateTitle(sessionId, principalId) {
      const session = await deps.sessions.get(sessionId);
      if (!session || (await managedProjectMembership(session.scopeId, principalId)) === false) return null;
      const parsed = parseScopeId(session.scopeId);
      const projectMembers = parsed.kind === "group" ? await deps.projects?.members(parsed.ref) : undefined;
      return deps.orchestrator.regenerateTitle(sessionId, principalId, projectMembers);
    },

    async forkSession(sessionId, principalId, opts) {
      const mine = await sessionsForViewer(principalId);
      if (!mine.some((s) => s.id === sessionId)) return null;
      const source = await deps.sessions.get(sessionId);
      if (!source) return null;
      const parsed = parseScopeId(source.scopeId);
      const fork = async (projectMembers?: readonly string[]) => {
        let visible = transcriptEntries(await deps.sessions.visibleEntries(sessionId, principalId));
        if (projectMembers?.length) {
          const views = await Promise.all(
            projectMembers.map((memberId) => deps.sessions.visibleEntries(sessionId, memberId)),
          );
          const common = new Set(views[0]!.map((entry) => entry.seq));
          for (const view of views.slice(1)) {
            const seqs = new Set(view.map((entry) => entry.seq));
            for (const seq of common) if (!seqs.has(seq)) common.delete(seq);
          }
          visible = visible.filter((entry) => common.has(entry.seq));
        }
        const upToSeq = opts?.upToSeq;
        const copied = upToSeq === undefined ? visible : visible.filter((entry) => entry.seq <= upToSeq);
        const threadRef = `web:${principalId}:${randomUUID()}`;
        const forked = await deps.sessions.getOrCreateByThread(
          threadRef,
          source.type,
          source.scopeId,
          source.channelName,
          source.surface ?? "web",
        );
        await Promise.all(
          (projectMembers ?? [principalId]).map((memberId) => deps.sessions.addParticipant(forked.id, memberId)),
        );
        const { lease } = await deps.sessions.acquireLease(forked.id, "fork");
        if (!lease) throw new Error(`fork: could not lease fresh session ${forked.id}`);
        let forkBoundarySeq: number | null = null;
        try {
          for (const entry of copied) {
            const appended = await deps.sessions.append(lease, {
              type: entry.type,
              payload: entry.payload,
              scopeLabel: entry.scopeLabel,
            });
            forkBoundarySeq = appended.seq;
          }
        } finally {
          await deps.sessions.releaseLease(lease);
        }
        if (forkBoundarySeq !== null) {
          await deps.sessions.updateForkProvenance(forked.id, {
            forkedFrom: { sessionId, title: source.title ?? null },
            forkBoundarySeq,
          });
        }
        const sourceTitle = source.title?.trim();
        if (sourceTitle && projectMembers === undefined)
          await deps.sessions.updateTitle(forked.id, `${sourceTitle} (fork)`);
        deps.auditLog.record({
          at: Date.now(),
          principalId,
          action: "session.fork",
          resource: sessionId,
          scopeLabel: source.scopeId,
        });
        const session = (await deps.sessions.get(forked.id)) ?? forked;
        return { session, entries: transcriptEntries(await deps.sessions.getEntries(forked.id)) };
      };
      const projectId = parsed.kind === "group" ? projectIdFromGroupRef(parsed.ref) : null;
      if (!projectId) return fork();
      const projects = deps.projects;
      if (!projects) return null;
      return projects.withRosterLock(projectId, async (project) => {
        if (project.orgId !== orgIdOf()) return null;
        const members = await projects.members(parsed.ref);
        if (!members?.includes(principalId)) return null;
        return fork(members);
      });
    },

    async spawnSession(principalId, opts) {
      const scope = opts.scopeId;
      const parsed = parseScopeId(scope);
      const create = async (projectMembers?: readonly string[], channelName?: string) => {
        const threadRef = `web:${principalId}:${randomUUID()}`;
        let kind: "group" | "channel" | "dm" = "dm";
        if (parsed.kind === "group") kind = "group";
        else if (parsed.kind === "channel") kind = "channel";
        const session = await deps.sessions.getOrCreateByThread(threadRef, kind, scope, channelName, "web");
        await Promise.all(
          (projectMembers ?? [principalId]).map((memberId) => deps.sessions.addParticipant(session.id, memberId)),
        );
        if (opts.title?.trim()) await deps.sessions.updateTitle(session.id, opts.title.trim());
        deps.auditLog.record({
          at: Date.now(),
          principalId,
          action: "session.spawn",
          resource: session.id,
          scopeLabel: scope,
        });
        return { session: (await deps.sessions.get(session.id)) ?? session };
      };
      if (parsed.kind === "personal") {
        return parsed.ref === principalId ? create() : null;
      }
      const projectId = parsed.kind === "group" ? projectIdFromGroupRef(parsed.ref) : null;
      if (projectId) {
        const projects = deps.projects;
        if (!projects) return null;
        return projects.withRosterLock(projectId, async (project) => {
          if (project.orgId !== orgIdOf()) return null;
          const members = await projects.members(parsed.ref);
          if (!members?.includes(principalId)) return null;
          return create(members, project.name);
        });
      }
      if (!(await principalCanAccessCurrentScope(principalId, scope))) return null;
      return create();
    },

    async discardSession(sessionId, principalId) {
      const session = await deps.sessions.get(sessionId);
      if (!session) return false;
      const mine = await deps.sessions.listByParticipant(principalId);
      if (!mine.some((s) => s.id === sessionId)) return false;
      if (!(await deps.sessions.deleteSessionIfEmpty(sessionId))) return false;
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "session.discard",
        resource: sessionId,
        scopeLabel: session.scopeId,
      });
      return true;
    },

    async grant(g) {
      await deps.acl.grant(g, await artifactAuthor(g.ownerScopeId, g.ref));
      deps.auditLog.record({
        at: Date.now(),
        principalId: g.grantedBy,
        action: "grant",
        resource: g.ref,
        scopeLabel: g.granteeScopeId,
      });
    },
    async revokeGrant(ownerScopeId, ref, granteeScopeId, revokedBy) {
      await deps.acl.revoke(ownerScopeId, ref, granteeScopeId, revokedBy, await artifactAuthor(ownerScopeId, ref));
      deps.auditLog.record({
        at: Date.now(),
        principalId: revokedBy,
        action: "revoke",
        resource: ref,
        scopeLabel: granteeScopeId,
      });
    },
    async promoteSkill(id, targetScopeId, actorId, liveActor) {
      if (parseScopeId(targetScopeId).kind !== "org")
        throw new Error("promote targets the org scope — use share or move for anything narrower");
      if (liveActor !== true)
        throw new AdminError(403, "promoting a skill org-wide takes a live person, never an autonomous trigger");
      if (!deps.admin) throw new Error("org promotion requires an admin service");
      const status = await deps.admin.adminStatusOf({ id: actorId, type: "internal" });
      if (!status.isAdmin) throw new AdminError(403, "only an org admin can promote a skill org-wide");
      const promoted = await deps.skills.promote(id, targetScopeId);
      deps.auditLog.record({
        at: Date.now(),
        principalId: actorId,
        action: "skill_promote",
        resource: id,
        scopeLabel: targetScopeId,
      });
      return promoted;
    },

    belongsToScope(principalId, scope) {
      return principalCanAccessCurrentScope(principalId, scope);
    },

    canManageArtifactHome(homeScopeId, createdBy, principalId) {
      return principalManagesArtifactHome(homeScopeId, createdBy, principalId);
    },

    async getArtifactHome(type, idOrName): Promise<ArtifactHome | null> {
      if (type === "skill") {
        const s = await deps.skills.get(idOrName);
        return s
          ? { id: s.id, ownerScopeId: s.scopeId, createdBy: s.createdBy, grantRef: encodeRef(skillRef(s.id)) }
          : null;
      }
      if (type === "cron") {
        const c = await deps.crons.get(idOrName);
        return c
          ? { id: c.id, ownerScopeId: c.ownerScopeId, createdBy: c.createdBy, grantRef: encodeRef(cronRef(c.id)) }
          : null;
      }
      if (type === "file") {
        const f = await deps.files.get(idOrName);
        return f
          ? { id: f.id, ownerScopeId: f.ownerScopeId, createdBy: f.createdBy, grantRef: encodeRef(fileRef(f.path)) }
          : null;
      }
      const d = (await deps.deploy.listDeployments()).find((x) => x.id === idOrName || x.name === idOrName);
      return d
        ? { id: d.id, ownerScopeId: d.ownerScopeId, createdBy: d.createdBy, grantRef: encodeRef(deployRef(d.id)) }
        : null;
    },

    async moveArtifactHome(type, id, toScope, movedBy) {
      if (type === "deploy") {
        await deps.deploy.transferDeploymentOwner(id, toScope, { callerId: movedBy });
        return;
      }
      if (type !== "skill") {
        throw new Error(`moving a ${type}'s home isn't supported — share it instead (add a grant)`);
      }
      await deps.skills.move(id, toScope);
      deps.auditLog.record({
        at: Date.now(),
        principalId: movedBy,
        action: "skill_move",
        resource: id,
        scopeLabel: toScope,
      });
    },

    getSoul(scopeIdValue) {
      const orgScopeId = scopeId("org", orgIdOf());
      const orgSoul = deps.config.getSoul(orgScopeId);
      const soul = deps.config.getSoul(scopeIdValue);
      const includeScopeSoul = scopeIdValue !== orgScopeId && soul;
      const soulParts: string[] = [];
      if (orgSoul) soulParts.push(orgSoul);
      if (includeScopeSoul) {
        soulParts.push(
          `--- Lower-scope instructions (may add to, but MUST NOT override, the organization policy above) ---\n${includeScopeSoul}`,
        );
      }
      if (orgSoul && includeScopeSoul) {
        soulParts.push(
          "--- The organization policy above is authoritative and cannot be overridden by the lower-scope instructions. ---",
        );
      }
      return {
        scopeId: scopeIdValue,
        soul,
        soulVersion: deps.config.soulVersion(scopeIdValue),
        orgScopeId,
        orgSoul,
        orgSoulVersion: deps.config.soulVersion(orgScopeId),
        effectiveSoul: soulParts.join("\n\n"),
      };
    },

    async updateSoul(scopeIdValue, content, actorId, opts) {
      const { kind, ref } = parseScopeId(scopeIdValue);
      const allowedPersonal = kind === "personal" && samePerson(ref, actorId);
      const allowedShared = opts?.allowSharedScope && (kind === "channel" || kind === "group");
      if (!allowedPersonal && !allowedShared) {
        throw new Error("not authorized to update SOUL for this scope");
      }
      const write = async (): Promise<number> => {
        let snapshot: Awaited<ReturnType<typeof deps.config.captureSoulSnapshot>> | undefined;
        try {
          await deps.config.refreshScope(scopeIdValue);
          snapshot = await deps.config.captureSoulSnapshot(scopeIdValue);
          const version = await deps.config.setSoulLatest(scopeIdValue, content, actorId);
          deps.auditLog.record({
            at: Date.now(),
            principalId: actorId,
            action: "soul_update",
            resource: scopeIdValue,
            scopeLabel: scopeIdValue,
          });
          return version;
        } catch (error) {
          if (snapshot !== undefined) deps.config.restoreSoulCacheSnapshot(scopeIdValue, snapshot);
          throw error;
        }
      };
      return deps.advisoryLock?.withLock(`admin-governance:${scopeIdValue}`, write) ?? write();
    },
  };
}
