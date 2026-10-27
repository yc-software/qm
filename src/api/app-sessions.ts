import { swallowAs } from "../util/errors.ts";
import { type ParticipantPageQuery, itemWithinTenure } from "../sessions/session-store.ts";
import { scopeId } from "../types.ts";
import { fileArtifactId, artifactPath } from "../files/file-artifact-store.ts";
import { createTranscriptSource } from "../sessions/transcript-source.ts";
import { openGoal } from "../harness/goal.ts";
import { goalView } from "../runs/turn-stream.ts";
import { SEARCH_HIT_LIMIT, searchSnippet, searchTerms } from "../sessions/item-search.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import { ProcessSessionGoneError } from "../sandbox/exec-process-session.ts";
import { cronIsActive, cronTiedTo } from "../cron/cron-store.ts";
import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES, mimeFromName, safeAttachmentName } from "../core/attachments.ts";

import { type App, type AppDeps, toFileItem, type SessionSearchHit } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import {
  type SessionKit,
  readTail,
  readFor,
  decoratedPins,
  tenureOf,
  continuable,
  viewerStoredEntryAt,
  MAX_PIN_TEXT_CHARS,
  entryAt,
  mirrorNativePin,
  pinView,
  decorateSessions,
  MAX_LISTED_CHILDREN,
  MAX_SESSION_PINS,
} from "./app-session-kit.ts";
import { sessionLifecycleMethods, artifactMethods } from "./app-session-lifecycle.ts";
import { projectMethods, scopeMethods } from "./app-session-projects.ts";

function sessionViewMethods(k: SessionKit) {
  const { deps, h, transcripts } = k;
  return {
    async getSession(sessionId, window) {
      const session = await deps.sessions.get(sessionId);
      if (!session) return null;
      const [read, pinRecords] = await Promise.all([
        readTail(readFor(k, sessionId), window),
        deps.sessions.listPins(sessionId),
      ]);
      const pins = await decoratedPins(pinRecords, read.all, (seq) => deps.sessions.getItem(sessionId, seq));
      return {
        session,
        items: read.items,
        ...(read.earlier > 0 ? { earlierItems: read.earlier } : {}),
        ...(pins.length ? { pins } : {}),
      };
    },

    async canViewSessionSnapshot(sessionId, principalId, visibility) {
      if (
        !visibility ||
        ![visibility.minSeq, visibility.maxSeq, visibility.minCreatedAt, visibility.maxCreatedAt].every(
          Number.isFinite,
        ) ||
        visibility.minSeq > visibility.maxSeq ||
        visibility.minCreatedAt > visibility.maxCreatedAt
      )
        return false;
      if (!(await h.sessionForViewer(sessionId, principalId))) return false;
      const window = await tenureOf(k, sessionId, principalId);
      return (
        !!window &&
        itemWithinTenure({ seq: visibility.minSeq, createdAt: visibility.minCreatedAt }, window) &&
        itemWithinTenure({ seq: visibility.maxSeq, createdAt: visibility.maxCreatedAt }, window)
      );
    },

    async getSessionForViewer(sessionId, principalId, window) {
      const found = await h.sessionForViewer(sessionId, principalId);
      if (!found) return null;
      const session = await continuable(k, principalId, found);
      const [read, pinRecords, goals, latestRuns] = await Promise.all([
        readTail(readFor(k, sessionId, principalId), window),
        deps.sessions.listPins(sessionId),
        deps.sessions.goals([sessionId]),
        window?.beforeSeq === undefined ? deps.runs.latestForThreads([found.threadRef]) : undefined,
      ]);
      const goal = openGoal(goals.get(sessionId));
      const runtime = latestRuns?.get(found.threadRef)?.result?.runtime;
      const pins = await decoratedPins(pinRecords, read.all, (seq) =>
        viewerStoredEntryAt(k, sessionId, principalId, seq),
      );
      return {
        session,
        items: read.items,
        ...(read.earlier > 0 ? { earlierItems: read.earlier } : {}),
        ...(pins.length ? { pins } : {}),
        ...(goal ? { goal: goalView(goal) } : {}),
        ...(runtime ? { runtime } : {}),
      };
    },

    async pinConversationItem(threadRef, addedBy, pin) {
      const session = await deps.sessions.getByThread(threadRef);
      if (!session) return { error: "not_found" };
      const text = pin.text?.trim().slice(0, MAX_PIN_TEXT_CHARS);
      if (pin.entrySeq !== undefined) {
        const exists = (await entryAt(k, session.id, pin.entrySeq, addedBy)) !== undefined;
        if (!exists) return { error: "bad_entry" };
      }
      const rec = await deps.sessions.addPin(
        session.id,
        {
          ...(text ? { text } : {}),
          ...(pin.entrySeq !== undefined ? { entrySeq: pin.entrySeq } : {}),
          addedBy,
        },
        MAX_SESSION_PINS,
      );
      if (!rec) return (await deps.sessions.get(session.id)) ? { error: "limit" } : { error: "not_found" };
      await mirrorNativePin(k, session, rec.id, rec.entrySeq, false);
      const pinned = rec.entrySeq !== undefined ? await entryAt(k, session.id, rec.entrySeq, addedBy) : undefined;
      return { pin: pinView(rec, pinned) };
    },

    async listConversationPins(threadRef, reader) {
      const session = await deps.sessions.getByThread(threadRef);
      if (!session) return null;
      const pinRecords = await deps.sessions.listPins(session.id);
      if (!pinRecords.length) return [];
      const seqs = pinRecords.filter((p) => p.entrySeq !== undefined).map((p) => p.entrySeq!);
      const resolveMissing = (seq: number) => viewerStoredEntryAt(k, session.id, reader, seq);
      if (!seqs.length) return decoratedPins(pinRecords, [], resolveMissing);
      const latest = await deps.sessions.latestItemSeq(session.id);
      const minSeq = Math.min(...seqs);
      const visible = (await transcripts.forViewer(session.id, reader, { limit: Math.max(1, latest - minSeq + 1) }))
        .items;
      return decoratedPins(pinRecords, visible, resolveMissing);
    },

    async unpinConversationItem(threadRef, pinId) {
      const session = await deps.sessions.getByThread(threadRef);
      if (!session) return null;
      const rec = (await deps.sessions.listPins(session.id)).find((p) => p.id === pinId);
      const removed = await deps.sessions.removePin(session.id, pinId);
      if (removed && rec) await mirrorNativePin(k, session, rec.id, rec.entrySeq, true);
      return removed;
    },

    async getSessionItemForViewer(sessionId, principalId, seq) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session) return null;
      const item = await entryAt(k, sessionId, seq, principalId);
      return item ? { item } : null;
    },
  } satisfies Partial<App>;
}

function sessionListMethods(k: SessionKit) {
  const { deps, h } = k;
  return {
    listFilesForViewer: (principalId, opts, inScope) => h.filesForViewer(principalId, opts, inScope),

    async uploadFileForViewer(principalId, input) {
      const ownerScopeId = scopeId("personal", principalId);
      const createdInScope = input.scopeId ?? ownerScopeId;
      if (!(await h.principalCanAccessCurrentScope(principalId, createdInScope))) return null;
      const name = safeAttachmentName(input.name);
      const mimetype = (input.mimetype ?? mimeFromName(name)).split(";")[0]!.trim().toLowerCase() || mimeFromName(name);
      const id = fileArtifactId(`upload:${principalId}:${createdInScope}:${Date.now()}:${randomUUID()}`, "in", 0);
      const path = artifactPath(id, name);
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
          ref: artifact.id,
          granteeScopeId: createdInScope,
          permission: "read",
          grantedBy: principalId,
        });
      }
      h.audit(principalId, "file.upload", path, createdInScope);
      return toFileItem(artifact);
    },

    async openFileForViewer(id, principalId) {
      const art = await deps.files.get(id);
      if (!art) return null;
      const myScopes = await h.currentResourceScopesForViewer(principalId);
      let allowed = myScopes.includes(art.ownerScopeId);
      if (!allowed) {
        const grants = await deps.acl.grantsFor(art.ownerScopeId, art.id);
        allowed = grants.some((g) => myScopes.includes(g.granteeScopeId));
      }
      if (!allowed) return null;
      const opened = await deps.files.open(id);
      if (!opened) return null;
      return { name: art.name, mimetype: art.mimetype, sizeBytes: opened.sizeBytes, stream: opened.stream };
    },

    listSessions: async (principalId) => decorateSessions(k, principalId, await h.sessionsForViewer(principalId)),

    async listSessionPage(principalId, query) {
      const filter: ParticipantPageQuery = {
        limit: Math.max(1, Math.min(query.limit, 200)),
        archived: query.status === "archived",
        ...(query.before ? { before: query.before } : {}),
        ...(query.surface ? { surface: query.surface } : {}),
        ...(query.scopeId ? { scopeId: query.scopeId } : {}),
        ...(query.titleQuery ? { titleQuery: query.titleQuery } : {}),
      };
      if (query.status === "waiting") {
        filter.sessionIds = (await deps.approvals?.blockingSessionIds()) ?? [];
      }
      const firstPage = !query.before && query.status !== "archived";
      const [page, pinned, archived] = await Promise.all([
        deps.sessions.listParticipantPage(principalId, {
          ...filter,
          ...(query.status === "archived" ? {} : { pinned: false }),
        }),
        firstPage ? deps.sessions.listParticipantPage(principalId, { ...filter, pinned: true, limit: 200 }) : null,
        firstPage ? deps.sessions.listParticipantPage(principalId, { ...filter, archived: true, limit: 1 }) : null,
      ]);
      const rows = await h.viewableRows(principalId, [...(pinned?.sessions ?? []), ...page.sessions]);
      let decorated = await decorateSessions(k, principalId, rows);
      if (query.status === "waiting") decorated = decorated.filter((s) => s.awaitingInput);
      const pinnedIds = new Set(pinned?.sessions.map((s) => s.id) ?? []);
      return {
        sessions: decorated.filter((s) => !pinnedIds.has(s.id)),
        ...(pinned ? { pinned: decorated.filter((s) => pinnedIds.has(s.id)) } : {}),
        ...(archived ? { hasArchived: archived.sessions.length > 0 } : {}),
        next: page.next,
      };
    },

    async sessionChildren(principalId, sessionId) {
      const root = await h.sessionForViewer(sessionId, principalId);
      if (!root) return null;
      const children = await deps.sessions.listDescendantsForParticipant(root.id, principalId, MAX_LISTED_CHILDREN);
      return decorateSessions(k, principalId, children);
    },

    async sessionRow(principalId, ref) {
      const id = ref.id ?? (ref.threadRef ? (await deps.sessions.getByThread(ref.threadRef))?.id : undefined);
      if (!id) return null;
      const session = await h.sessionForViewer(id, principalId);
      if (!session) return null;
      const { spawnMeta: _spawnMeta, clientTools: _clientTools, ...row } = session;
      const [decorated] = await decorateSessions(k, principalId, [row]);
      return decorated ?? null;
    },

    async searchSessions(principalId, query, limit = SEARCH_HIT_LIMIT): Promise<SessionSearchHit[]> {
      const capped = Math.max(1, Math.floor(limit));
      const [hits, titles] = await Promise.all([
        deps.sessions.searchItems(principalId, query, capped).then((rows) => h.viewableRows(principalId, rows)),
        deps.sessions.searchSessionTitles(principalId, query, capped).then((rows) => h.viewableRows(principalId, rows)),
      ]);
      const terms = searchTerms(query);
      const entryHits: SessionSearchHit[] = hits.map((hit) => ({
        sessionId: hit.sessionId,
        title: hit.title ?? null,
        scopeId: hit.scopeId,
        ...(hit.channelName ? { channelName: hit.channelName } : {}),
        ...(hit.surface ? { surface: hit.surface } : {}),
        seq: hit.seq,
        entryType: hit.type,
        ...(hit.author ? { author: hit.author } : {}),
        snippet: searchSnippet(hit.text, terms),
        createdAt: hit.createdAt,
        ...(hit.archived ? { archived: true } : {}),
      }));
      const entryHitSessions = new Set(entryHits.map((hit) => hit.sessionId));
      const titleHits: SessionSearchHit[] = titles
        .filter((s) => !entryHitSessions.has(s.id))
        .map((s) => ({
          sessionId: s.id,
          title: s.title ?? null,
          scopeId: s.scopeId,
          ...(s.channelName ? { channelName: s.channelName } : {}),
          ...(s.surface ? { surface: s.surface } : {}),
          seq: 0,
          entryType: "title",
          snippet: s.title ?? s.id,
          createdAt: s.lastActivityAt ?? s.createdAt,
          ...(s.archived ? { archived: true } : {}),
        }));
      return [...titleHits, ...entryHits].slice(0, capped);
    },
  } satisfies Partial<App>;
}

function sessionActivityMethods(k: SessionKit) {
  const { deps, h } = k;
  return {
    async sessionBackground(sessionId, viewer) {
      const session = await h.sessionForViewer(sessionId, viewer);
      if (!session) return null;
      const now = Date.now();
      const jobs = ((await deps.processes?.listLive(now)) ?? [])
        .filter((r) => r.kind === "background" && r.sessionRef === session.threadRef)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((r) => ({
          processId: r.processId,
          command: r.command,
          ...(r.purpose ? { purpose: r.purpose } : {}),
          startedAt: r.startedAt,
          expiresAt: r.expiresAt,
        }));
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
      const crons = await Promise.all(
        (await deps.crons.list())
          .filter((c) => cronIsActive(c) && cronTiedTo(c, session.threadRef))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(async (c) => {
            const last = (await deps.crons.listFires(c.id, { limit: 1 })).runs[0];
            return {
              id: c.id,
              ...(c.title !== undefined ? { title: c.title } : {}),
              ...(c.nextFireAt !== undefined ? { nextFireAt: c.nextFireAt } : {}),
              ...(last ? { lastFire: { firedAt: last.firedAt, ...(last.status ? { status: last.status } : {}) } } : {}),
            };
          }),
      );
      return { jobs, watches, crons };
    },

    async readSessionBackgroundOutput(sessionId, processId, viewer, sinceCursor) {
      const session = await h.sessionForViewer(sessionId, viewer);
      if (!session || !deps.processes || !deps.sandbox || !supportsProcessSessions(deps.sandbox)) return null;
      const sandbox = deps.sandbox;
      const rec = await deps.processes.get(processId);
      if (!rec || rec.kind !== "background" || rec.sessionRef !== session.threadRef) return null;
      const handle = await sandbox.provision(
        [{ scopeId: rec.scopeId, mode: "rw", mountPath: "" }],
        rec.sandboxId ? { sandboxId: rec.sandboxId } : undefined,
      );
      try {
        const read = await sandbox.readProcess(handle, processId, { sinceCursor, maxBytes: 65_536, waitMs: 0 });
        return {
          chunk: read.chunks,
          cursor: read.cursor,
          state: read.status.state,
          ...(read.status.state === "exited" ? { exitCode: read.status.code } : {}),
        };
      } catch (e) {
        if (e instanceof ProcessSessionGoneError) return { chunk: "", cursor: sinceCursor, state: "exited" };
        throw e;
      } finally {
        await sandbox
          .teardown(handle, { keepWarm: true })
          .catch(swallowAs("app sessions: release process sandbox", undefined));
      }
    },
  } satisfies Partial<App>;
}

export function createSessionMethods(deps: AppDeps, h: AppHelpers) {
  const k: SessionKit = { deps, h, transcripts: createTranscriptSource(deps.sessions) };
  return {
    ...sessionViewMethods(k),
    ...sessionListMethods(k),
    ...sessionActivityMethods(k),
    ...projectMethods(k),
    ...scopeMethods(k),
    ...sessionLifecycleMethods(k),
    ...artifactMethods(k),
  };
}
