import { randomUUID } from "node:crypto";
import type { Session, SessionEntry, ScopeId } from "../types.ts";
import type {
  AttributedTurn,
  EntrySearchHit,
  CronGroupSummary,
  GetEntriesOptions,
  GetTapeOptions,
  LeaseAttempt,
  LeaseHolder,
  LlmRequestRecord,
  NewEntry,
  NewLlmRequest,
  NewTapeRecord,
  ParticipantWindow,
  ScopeSessionStats,
  SessionPage,
  SessionStore,
  SessionSummary,
  StoreOptions,
  TapeRecord,
} from "./session-store.ts";
import { entrySearchAuthor, entrySearchText, matchesSearchTerms, searchTerms } from "./entry-search.ts";
import {
  cronIdOf,
  isOverheardEntry,
  promptEnvelopeBody,
  sessionBucket,
  sessionCategory,
  sessionOrigin,
  userMessagePreview,
} from "./session-store.ts";

function idDesc(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

export function createMemorySessionStore(opts: StoreOptions = {}): SessionStore {
  const now = opts.now ?? (() => Date.now());
  const leaseTtlMs = opts.leaseTtlMs ?? 5 * 60_000;
  const sessions = new Map<string, Session>();
  const entries = new Map<string, SessionEntry[]>();
  const tape = new Map<string, TapeRecord[]>();
  const llmRequests = new Map<string, LlmRequestRecord[]>();
  const promptEnvelopes = new Map<string, string>();
  const byThread = new Map<string, string>();
  const participants = new Map<string, Set<string>>();
  const windows = new Map<
    string,
    Map<
      string,
      {
        validFrom: number;
        validTo: number | null;
        validFromSeq: number;
        validToSeq: number | null;
        title?: string | null;
        archived?: boolean;
        pinned?: boolean;
        color?: string | null;
      }
    >
  >();
  const leases = new Map<string, { token: string; expiresAt: number; acquiredAt: number; holder?: LeaseHolder }>();

  return {
    async getOrCreateByThread(threadRef, type, scopeId, channelName, surface) {
      const existingId = byThread.get(threadRef);
      if (existingId) {
        const s = sessions.get(existingId);
        if (s) {
          if (channelName && s.channelName !== channelName) s.channelName = channelName;
          if (surface && !s.surface) s.surface = surface;
          return s;
        }
      }
      const session: Session = {
        id: randomUUID(),
        type,
        scopeId,
        threadRef,
        createdAt: Date.now(),
        ...(channelName ? { channelName } : {}),
        ...(surface ? { surface } : {}),
      };
      sessions.set(session.id, session);
      entries.set(session.id, []);
      byThread.set(threadRef, session.id);
      return session;
    },

    async getByThread(threadRef) {
      const id = byThread.get(threadRef);
      return (id && sessions.get(id)) || null;
    },

    async get(id) {
      return sessions.get(id) ?? null;
    },

    async updateTitle(sessionId, title) {
      const s = sessions.get(sessionId);
      if (s) s.title = title;
    },

    async updateForkProvenance(sessionId, provenance) {
      const s = sessions.get(sessionId);
      if (s) Object.assign(s, provenance);
    },

    async acquireLease(sessionId, holder): Promise<LeaseAttempt> {
      if (!sessions.has(sessionId)) return { lease: null };
      const held = leases.get(sessionId);
      if (held && now() < held.expiresAt)
        return {
          lease: null,
          ...(held.holder ? { heldBy: held.holder } : {}),
          heldSince: held.acquiredAt,
          heldUntil: held.expiresAt,
        };
      const token = randomUUID();
      leases.set(sessionId, {
        token,
        expiresAt: now() + leaseTtlMs,
        acquiredAt: now(),
        ...(holder ? { holder } : {}),
      });
      return { lease: { sessionId, token } };
    },

    async releaseLease(lease) {
      if (leases.get(lease.sessionId)?.token === lease.token) leases.delete(lease.sessionId);
    },

    async deleteSession(sessionId) {
      const s = sessions.get(sessionId);
      if (s) byThread.delete(s.threadRef);
      for (const principalId of windows.get(sessionId)?.keys() ?? []) {
        participants.get(principalId)?.delete(sessionId);
      }
      sessions.delete(sessionId);
      entries.delete(sessionId);
      tape.delete(sessionId);
      llmRequests.delete(sessionId);
      windows.delete(sessionId);
      leases.delete(sessionId);
    },

    async deleteSessionIfEmpty(sessionId) {
      if (!sessions.has(sessionId)) return false;
      if ((entries.get(sessionId)?.length ?? 0) > 0) return false;
      const held = leases.get(sessionId);
      if (held && now() < held.expiresAt) return false;
      await this.deleteSession(sessionId);
      return true;
    },

    async forceReleaseLease(sessionId) {
      leases.delete(sessionId);
    },

    async append(lease, entry: NewEntry): Promise<SessionEntry> {
      const held = leases.get(lease.sessionId);
      if (!held || held.token !== lease.token) {
        throw new Error("append without a valid session lease");
      }
      held.expiresAt = now() + leaseTtlMs;
      const log = entries.get(lease.sessionId);
      if (!log) throw new Error(`unknown session: ${lease.sessionId}`);
      const seq = log.length;
      const full: SessionEntry = {
        sessionId: lease.sessionId,
        seq,
        parentSeq: seq === 0 ? null : seq - 1,
        type: entry.type,
        payload: entry.payload,
        scopeLabel: entry.scopeLabel as ScopeId,
        createdAt: now(),
      };
      log.push(full);
      return full;
    },

    async getEntries(sessionId, opts?: GetEntriesOptions) {
      const log = entries.get(sessionId) ?? [];
      const since = opts?.sinceSeq ?? 0;
      const filtered = log.filter((e) => e.seq >= since);
      return opts?.limit !== undefined ? filtered.slice(-opts.limit) : filtered;
    },

    async clearSecurityTaint(sessionId) {
      const log = entries.get(sessionId);
      if (!log) return false;
      for (const entry of log) {
        if (!entry.payload || typeof entry.payload !== "object") continue;
        const payload = { ...(entry.payload as Record<string, unknown>) };
        delete payload.securityTainted;
        entry.payload = payload;
      }
      return true;
    },

    async appendTape(lease, rec: NewTapeRecord): Promise<TapeRecord> {
      const held = leases.get(lease.sessionId);
      if (!held || held.token !== lease.token) throw new Error("tape append without a valid session lease");
      held.expiresAt = now() + leaseTtlMs;
      const log = tape.get(lease.sessionId) ?? [];
      tape.set(lease.sessionId, log);
      const full: TapeRecord = { ...rec, sessionId: lease.sessionId, seq: log.length, createdAt: now() };
      log.push(full);
      return full;
    },

    async getTape(sessionId, opts?: GetTapeOptions) {
      const log = tape.get(sessionId) ?? [];
      const since = opts?.sinceSeq;
      const filtered = since !== undefined ? log.filter((r) => r.seq > since) : log;
      return opts?.limit !== undefined ? filtered.slice(-opts.limit) : [...filtered];
    },

    async tapeCoverage(sessionId) {
      const log = tape.get(sessionId) ?? [];
      return log.reduce(
        (m, r) =>
          Math.max(
            m,
            r.kind === "annotation" && (r.payload as { turnEnd?: unknown } | null)?.turnEnd === true
              ? (r.entrySeq ?? -1)
              : -1,
            r.kind === "context_event" && (r.payload as { event?: unknown } | null)?.event === "legacy_import"
              ? (r.coversEntrySeq ?? -1)
              : -1,
          ),
        -1,
      );
    },

    async recordLlmRequest(sessionId, rec: NewLlmRequest) {
      const envelope = promptEnvelopeBody(rec.promptEnvelope);
      if (envelope && !promptEnvelopes.has(envelope.hash)) promptEnvelopes.set(envelope.hash, envelope.body);
      const full: LlmRequestRecord = {
        id: randomUUID(),
        sessionId,
        turnSeq: rec.turnSeq,
        step: rec.step,
        model: rec.model,
        scopeLabel: rec.scopeLabel as ScopeId,
        createdAt: now(),
        request: null,
        promptHash: envelope?.hash ?? null,
        truncated: rec.truncated ?? false,
        ttftMs: rec.ttftMs ?? null,
        durationMs: rec.durationMs ?? null,
        stepGapMs: rec.stepGapMs ?? null,
        toolWallMs: rec.toolWallMs ?? null,
        gapPhases: rec.gapPhases ?? null,
        usage: rec.usage ?? null,
        transport: rec.transport ?? null,
      };
      let arr = llmRequests.get(sessionId);
      if (!arr) {
        arr = [];
        llmRequests.set(sessionId, arr);
      }
      arr.push(full);
      return rec.promptEnvelope !== undefined ? { ...full, promptEnvelope: rec.promptEnvelope } : full;
    },

    async listLlmRequests(sessionId, opts) {
      const all = llmRequests.get(sessionId) ?? [];
      const want = opts?.turnSeqs ? new Set(opts.turnSeqs) : null;
      const filtered =
        want || opts?.orphans
          ? all.filter(
              (r) =>
                (want != null && r.turnSeq !== null && want.has(r.turnSeq)) || (!!opts?.orphans && r.turnSeq === null),
            )
          : all;
      return filtered.map((r) => {
        if (opts?.omitRequest) return { ...r, request: null };
        const body = r.promptHash != null ? promptEnvelopes.get(r.promptHash) : undefined;
        return body !== undefined ? { ...r, promptEnvelope: JSON.parse(body) } : { ...r };
      });
    },

    async addParticipant(sessionId, principalId, title, opts) {
      const includeHistory = opts?.includeHistory === true;
      let set = participants.get(principalId);
      if (!set) {
        set = new Set();
        participants.set(principalId, set);
      }
      set.add(sessionId);
      let w = windows.get(sessionId);
      if (!w) {
        w = new Map();
        windows.set(sessionId, w);
      }
      const existing = w.get(principalId);
      if (!existing || existing.validTo !== null) {
        const retainedTitle = title !== undefined ? title : existing?.title;
        w.set(principalId, {
          validFrom: includeHistory ? 0 : now(),
          validTo: null,
          validFromSeq: includeHistory ? 0 : (entries.get(sessionId)?.length ?? 0),
          validToSeq: null,
          ...(retainedTitle != null ? { title: retainedTitle } : {}),
          ...(existing?.archived ? { archived: existing.archived } : {}),
          ...(existing?.pinned ? { pinned: existing.pinned } : {}),
          ...(existing?.color != null ? { color: existing.color } : {}),
        });
      } else {
        if (includeHistory) {
          existing.validFrom = 0;
          existing.validFromSeq = 0;
        }
        if (title !== undefined) existing.title = title;
      }
    },

    async removeParticipant(sessionId, principalId) {
      const win = windows.get(sessionId)?.get(principalId);
      if (win && win.validTo === null) {
        win.validTo = now();
        win.validToSeq = entries.get(sessionId)?.length ?? 0;
      }
    },

    async listByParticipant(principalId) {
      const ids = participants.get(principalId);
      if (!ids) return [];
      const out: Session[] = [];
      for (const id of ids) {
        const s = sessions.get(id);
        if (!s) continue;
        const view = windows.get(id)?.get(principalId);
        const all = entries.get(id) ?? [];
        const log = all.filter((e) => e.type === "user");
        const lastActivityAt = log.length ? Math.max(s.createdAt, ...log.map((e) => e.createdAt)) : s.createdAt;
        const visible = view
          ? all.some((e) => e.seq >= view.validFromSeq && (view.validToSeq === null || e.seq < view.validToSeq))
          : false;
        out.push({
          ...s,
          ...(view?.title != null ? { title: view.title } : {}),
          ...(view?.archived ? { archived: true } : {}),
          ...(view?.pinned ? { pinned: true } : {}),
          ...(view?.color != null ? { color: view.color } : {}),
          lastActivityAt,
          hasEntries: visible,
        });
      }
      return out;
    },

    async updateParticipantView(sessionId, principalId, patch) {
      const view = windows.get(sessionId)?.get(principalId);
      if (!view) return;
      if (patch.title !== undefined) view.title = patch.title;
      if (patch.archived !== undefined) view.archived = patch.archived;
      if (patch.pinned !== undefined) view.pinned = patch.pinned;
      if (patch.color !== undefined) view.color = patch.color;
    },

    async visibleEntries(sessionId, principalId) {
      const win = windows.get(sessionId)?.get(principalId);
      if (!win) return [];
      const log = entries.get(sessionId) ?? [];
      return log.filter((e) => e.seq >= win.validFromSeq && (win.validToSeq === null || e.seq < win.validToSeq));
    },

    async searchEntries(principalId, query, limit = 40): Promise<EntrySearchHit[]> {
      const terms = searchTerms(query);
      if (!terms.length) return [];
      const searchable = new Set(["user", "assistant", "text"]);
      const hits: EntrySearchHit[] = [];
      for (const sessionId of participants.get(principalId) ?? []) {
        const win = windows.get(sessionId)?.get(principalId);
        if (!win) continue;
        for (const e of entries.get(sessionId) ?? []) {
          if (!searchable.has(e.type)) continue;
          if (e.seq < win.validFromSeq || (win.validToSeq !== null && e.seq >= win.validToSeq)) continue;
          const text = entrySearchText(e.payload);
          if (!text || !matchesSearchTerms(text, terms)) continue;
          const author = entrySearchAuthor(e);
          hits.push({
            sessionId,
            seq: e.seq,
            type: e.type,
            ...(author ? { author } : {}),
            text,
            createdAt: e.createdAt,
          });
        }
      }
      hits.sort((a, b) => b.createdAt - a.createdAt || idDesc(a.sessionId, b.sessionId) || b.seq - a.seq);
      return hits.slice(0, Math.max(1, Math.min(limit, 200)));
    },

    async listAll() {
      return [...sessions.values()];
    },

    async sessionsByThreadRefs(threadRefs) {
      const wanted = new Set(threadRefs);
      return [...sessions.values()]
        .filter((s) => wanted.has(s.threadRef))
        .map((s) => ({ id: s.id, threadRef: s.threadRef, scopeId: s.scopeId, type: s.type, title: s.title ?? null }));
    },

    async distinctScopes() {
      const byScope = new Map<string, string | undefined>();
      for (const s of sessions.values()) {
        const prev = byScope.get(s.scopeId);
        if (!byScope.has(s.scopeId) || (s.channelName && !prev)) byScope.set(s.scopeId, s.channelName);
      }
      return [...byScope].map(([scopeId, channelName]) => ({ scopeId, ...(channelName ? { channelName } : {}) }));
    },

    async scopeSessionSummaries(
      scope,
      orgWide,
      page?: SessionPage,
      includePreviews = true,
      sessionIds?: string[],
    ): Promise<SessionSummary[]> {
      const idSet = sessionIds ? new Set(sessionIds) : null;
      const out: SessionSummary[] = [];
      for (const s of sessions.values()) {
        if (!orgWide && s.scopeId !== scope) continue;
        if (idSet && !idSet.has(s.id)) continue;
        const origin = sessionOrigin(s.threadRef);
        if (page?.category && sessionCategory(origin) !== page.category) continue;
        if (
          page?.origin === "other_background"
            ? origin === "conversation" || origin === "cron"
            : page?.origin && origin !== page.origin
        )
          continue;
        if (page?.cronId && cronIdOf(s.threadRef) !== page.cronId) continue;
        const log = entries.get(s.id) ?? [];
        const userEntries = log.filter((e) => e.type === "user" && !isOverheardEntry(e));
        out.push({
          id: s.id,
          type: s.type,
          origin,
          scopeId: s.scopeId,
          threadRef: s.threadRef,
          turns: userEntries.length,
          messages: log.length,
          lastActivity: log.length ? log[log.length - 1]!.createdAt : s.createdAt,
          createdAt: s.createdAt,
          firstMessage: includePreviews && userEntries.length ? userMessagePreview(userEntries[0]!.payload) : "",
          lastMessage:
            includePreviews && userEntries.length
              ? userMessagePreview(userEntries[userEntries.length - 1]!.payload, 100)
              : "",
        });
      }
      out.sort((a, b) => b.lastActivity - a.lastActivity || idDesc(a.id, b.id));
      if (!page) return out;
      const before = page.before;
      if (before) {
        return out
          .filter(
            (r) => r.lastActivity < before.lastActivity || (r.lastActivity === before.lastActivity && r.id < before.id),
          )
          .slice(0, page.limit);
      }
      return out.slice(page.offset, page.offset + page.limit);
    },

    async lastUserMessages(sessionIds): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      for (const id of sessionIds) {
        const log = entries.get(id) ?? [];
        const userEntries = log.filter((e) => e.type === "user" && !isOverheardEntry(e));
        if (userEntries.length) out.set(id, userMessagePreview(userEntries[userEntries.length - 1]!.payload, 100));
      }
      return out;
    },

    async scopeCronGroups(scope, orgWide): Promise<CronGroupSummary[]> {
      const groups = new Map<string, CronGroupSummary>();
      for (const s of sessions.values()) {
        if (!orgWide && s.scopeId !== scope) continue;
        const cronId = cronIdOf(s.threadRef);
        if (!cronId) continue;
        const log = entries.get(s.id) ?? [];
        const turns = log.filter((e) => e.type === "user" && !isOverheardEntry(e)).length;
        const lastActivity = log.length ? log[log.length - 1]!.createdAt : s.createdAt;
        const g = groups.get(cronId) ?? {
          cronId,
          scopeId: s.scopeId,
          sessions: 0,
          turns: 0,
          messages: 0,
          lastActivity: 0,
          createdAt: s.createdAt,
        };
        g.sessions += 1;
        g.turns += turns;
        g.messages += log.length;
        g.lastActivity = Math.max(g.lastActivity, lastActivity);
        g.createdAt = Math.min(g.createdAt, s.createdAt);
        groups.set(cronId, g);
      }
      return [...groups.values()].sort((a, b) => {
        if (b.lastActivity !== a.lastActivity) return b.lastActivity - a.lastActivity;
        if (a.cronId < b.cronId) return 1;
        if (a.cronId > b.cronId) return -1;
        return 0;
      });
    },

    async scopeSessionStats(scope, orgWide, category, originFilter, cronId): Promise<ScopeSessionStats> {
      const byType: Record<string, number> = {};
      const byTypeAll: Record<string, number> = {};
      const totalByCategory = { conversation: 0, background: 0, all: 0 };
      const cronIds = new Set<string>();
      let total = 0;
      let turns = 0;
      for (const s of sessions.values()) {
        if (!orgWide && s.scopeId !== scope) continue;
        const origin = sessionOrigin(s.threadRef);
        const cat = sessionCategory(origin);
        totalByCategory[cat]++;
        totalByCategory.all++;
        const bucket = sessionBucket(origin, s.type);
        byTypeAll[bucket] = (byTypeAll[bucket] ?? 0) + 1;
        const sessionCronId = cronIdOf(s.threadRef);
        if (sessionCronId != null) cronIds.add(sessionCronId);
        if (category && cat !== category) continue;
        if (
          originFilter === "other_background"
            ? origin === "conversation" || origin === "cron"
            : originFilter && origin !== originFilter
        )
          continue;
        if (cronId && sessionCronId !== cronId) continue;
        total++;
        const log = entries.get(s.id) ?? [];
        turns += log.filter((e) => e.type === "user" && !isOverheardEntry(e)).length;
        byType[bucket] = (byType[bucket] ?? 0) + 1;
      }
      return { total, turns, byType, byTypeAll, totalByCategory, crons: cronIds.size };
    },

    async attributedTurns(): Promise<AttributedTurn[]> {
      const DAY = 86_400_000;
      const out: AttributedTurn[] = [];
      for (const [sessionId, byPrincipal] of windows) {
        const log = (entries.get(sessionId) ?? []).filter((e) => e.type === "user" && !isOverheardEntry(e));
        for (const [principalId, w] of byPrincipal) {
          const buckets = new Map<number, { turns: number; firstAt: number; lastAt: number }>();
          for (const e of log) {
            const t = e.createdAt;
            if (e.seq < w.validFromSeq || (w.validToSeq !== null && e.seq >= w.validToSeq)) continue;
            const day = Math.floor(t / DAY);
            const b = buckets.get(day);
            if (b) {
              b.turns += 1;
              if (t < b.firstAt) b.firstAt = t;
              if (t > b.lastAt) b.lastAt = t;
            } else buckets.set(day, { turns: 1, firstAt: t, lastAt: t });
          }
          for (const [day, b] of buckets)
            out.push({ principalId, sessionId, day, turns: b.turns, firstAt: b.firstAt, lastAt: b.lastAt });
        }
      }
      return out;
    },

    async listParticipants() {
      const out: ParticipantWindow[] = [];
      for (const [sessionId, byPrincipal] of windows) {
        for (const [principalId, w] of byPrincipal) {
          out.push({ sessionId, principalId, validFrom: w.validFrom, validTo: w.validTo });
        }
      }
      return out;
    },

    async participantsOf(sessionId) {
      return [...(windows.get(sessionId)?.keys() ?? [])];
    },
  };
}
