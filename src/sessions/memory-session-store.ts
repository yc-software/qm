import { transcriptEntries } from "./transcript-source.ts";
import { randomUUID } from "node:crypto";
import type { Session, SessionEntry, ScopeId } from "../types.ts";
import type { GoalRecord } from "../harness/goal.ts";
import type {
  AttributedTurn,
  EntrySearchHit,
  ScopeActivity,
  GetEntriesOptions,
  LeaseAttempt,
  LeaseHolder,
  LeasePeek,
  LlmRequestRecord,
  NewEntry,
  NewLlmRequest,
  NewSearchEntry,
  NewSessionPin,
  ParticipantPage,
  ParticipantScope,
  SessionDescendant,
  ParticipantWindow,
  SessionPage,
  SessionStore,
  SessionSummary,
  SessionPin,
  SpendRow,
  StoreOptions,
} from "./session-store.ts";
import {
  entrySearchAuthor,
  entrySearchText,
  matchesSearchTerms,
  searchEntryType,
  searchTerms,
} from "./entry-search.ts";
import {
  contextWindowFromEntries,
  cronIdOf,
  entryWithinTenure,
  isOverheardEntry,
  DuplicateCallError,
  promptEnvelopeBody,
  sessionCategory,
  sessionOrigin,
  userMessagePreview,
  isWebThread,
} from "./session-store.ts";
import { entryFromItem, itemFromEntry } from "./items.ts";
import { SECURITY_SCREEN_STEP, screenPayloadFromEnvelope } from "../security/security-posture.ts";

function toParticipantWindow(
  sessionId: string,
  principalId: string,
  w: Pick<ParticipantWindow, "validFrom" | "validTo" | "validFromSeq" | "validToSeq">,
): ParticipantWindow {
  return {
    sessionId,
    principalId,
    validFrom: w.validFrom,
    validTo: w.validTo,
    validFromSeq: w.validFromSeq,
    validToSeq: w.validToSeq,
  };
}

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
  const goals = new Map<string, GoalRecord>();
  const searchIndex = new Map<string, NewSearchEntry[]>();
  const llmRequests = new Map<string, LlmRequestRecord[]>();
  const llmRequestSeq = new Map<string, number>();
  let llmRequestCount = 0;
  const promptEnvelopes = new Map<string, string>();
  const byThread = new Map<string, string>();
  const participants = new Map<string, Set<string>>();
  const pins = new Map<string, SessionPin[]>();
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
        readAt?: number;
      }
    >
  >();
  const leases = new Map<string, { token: string; expiresAt: number; acquiredAt: number; holder?: LeaseHolder }>();

  const participantSession = (sessionId: string, principalId: string): Session | null => {
    const s = sessions.get(sessionId);
    if (!s) return null;
    const view = windows.get(sessionId)?.get(principalId);
    const all = entries.get(sessionId) ?? [];
    const log = all.filter((e) => e.type === "user");
    const lastActivityAt = log.length ? Math.max(s.createdAt, ...log.map((e) => e.createdAt)) : s.createdAt;
    const visible = view ? all.some((e) => entryWithinTenure(e, view)) : false;
    const replies = all.filter((e) => e.type === "assistant" || e.type === "text");
    const lastReply = replies.length ? Math.max(...replies.map((e) => e.createdAt)) : null;
    const unread = lastReply !== null && lastReply > (view?.readAt ?? 0) && isWebThread(s.threadRef);
    return {
      ...s,
      ...(view?.title != null ? { title: view.title } : {}),
      ...(view?.archived ? { archived: true } : {}),
      ...(view?.pinned ? { pinned: true } : {}),
      ...(view?.color != null ? { color: view.color } : {}),
      ...(unread ? { unread: true } : {}),
      lastActivityAt,
      hasEntries: visible,
    };
  };

  return {
    leaseTtlMs,
    async getOrCreateByThread(threadRef, type, scopeId, channelName, surface, clientTools, opts) {
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
        createdAt: now(),
        ...(clientTools?.length ? { clientTools: structuredClone(clientTools) } : {}),
        ...(channelName ? { channelName } : {}),
        ...(surface ? { surface } : {}),
        ...(opts?.incognito === true ? { incognito: true as const } : {}),
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

    async setParentSession(sessionId, parentSessionId) {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (parentSessionId === null) delete s.parentSessionId;
      else s.parentSessionId = parentSessionId;
    },

    async setSpawnMeta(sessionId, meta) {
      const s = sessions.get(sessionId);
      if (s) s.spawnMeta = meta;
    },

    async childrenOf(parentSessionId) {
      return [...sessions.values()]
        .filter((s) => s.parentSessionId === parentSessionId)
        .sort((a, b) => a.createdAt - b.createdAt);
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

    async peekLease(sessionId): Promise<LeasePeek | null> {
      const held = leases.get(sessionId);
      if (!held) return null;
      return { ...(held.holder ? { holder: held.holder } : {}), heldUntil: held.expiresAt };
    },

    async renewLease(lease) {
      const held = leases.get(lease.sessionId);
      if (!held || held.token !== lease.token || now() >= held.expiresAt) return false;
      held.expiresAt = now() + leaseTtlMs;
      return true;
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
      goals.delete(sessionId);
      searchIndex.delete(sessionId);
      llmRequests.delete(sessionId);
      windows.delete(sessionId);
      leases.delete(sessionId);
      pins.delete(sessionId);
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
      return (await this.appendMany(lease, [entry]))[0]!;
    },

    async appendMany(lease, batch: readonly NewEntry[]): Promise<SessionEntry[]> {
      const held = leases.get(lease.sessionId);
      if (!held || held.token !== lease.token || now() >= held.expiresAt) {
        throw new Error("append without a valid session lease");
      }
      held.expiresAt = now() + leaseTtlMs;
      const log = entries.get(lease.sessionId);
      if (!log) throw new Error(`unknown session: ${lease.sessionId}`);
      const copied = structuredClone(batch);
      const scopeLabel = sessions.get(lease.sessionId)?.scopeId ?? (copied[0]?.scopeLabel as ScopeId);
      const items = copied.map((entry) =>
        itemFromEntry(entry.type, entry.payload, { turnId: lease.turnId, author: entry.author }),
      );
      const calls = new Set(
        log.flatMap((e) => {
          const id = (e.payload as { callId?: unknown } | null)?.callId;
          return (e.type === "tool_call" || e.type === "tool_result") && typeof id === "string"
            ? [`${e.type}:${id}`]
            : [];
        }),
      );
      for (const [index, item] of items.entries()) {
        if (!item.callId) continue;
        const key = `${copied[index]!.type}:${item.callId}`;
        if (calls.has(key)) throw new DuplicateCallError(lease.sessionId, [item.callId]);
        calls.add(key);
      }
      return items.map((item) => {
        const seq = log.length;
        const full = entryFromItem({
          sessionId: lease.sessionId,
          seq,
          ...item,
          scopeLabel,
          createdAt: now(),
        });
        log.push(full);
        const searchType = searchEntryType(full);
        const text = searchType ? entrySearchText(full.payload) : null;
        if (searchType && text?.trim()) {
          const index = searchIndex.get(full.sessionId) ?? [];
          const author = entrySearchAuthor(full);
          index.push({
            seq: full.seq,
            type: searchType,
            text,
            createdAt: full.createdAt,
            ...(author ? { author } : {}),
          });
          searchIndex.set(full.sessionId, index);
        }
        return full;
      });
    },

    async hasDeliveryEntry(sessionId, deliveryKey, slackTs) {
      return (entries.get(sessionId) ?? []).some((entry) => {
        const payload = entry.payload as { deliveryKey?: string; ts?: string } | null;
        return (
          payload?.deliveryKey === deliveryKey ||
          (slackTs !== undefined && entry.type === "user" && payload?.ts === slackTs)
        );
      });
    },

    async getEntries(sessionId, opts?: GetEntriesOptions) {
      const all = (entries.get(sessionId) ?? []).filter(
        (e) => opts?.turnId === undefined || (e.payload as { runId?: string } | null)?.runId === opts.turnId,
      );
      const log = opts?.transcript ? transcriptEntries(all) : all;
      const since = opts?.sinceSeq ?? 0;
      const filtered = log.filter((e) => e.seq >= since && (opts?.beforeSeq === undefined || e.seq < opts.beforeSeq));
      return opts?.limit !== undefined ? filtered.slice(-opts.limit) : filtered;
    },

    async countEntriesBefore(sessionId, beforeSeq, principalId) {
      const win = principalId === undefined ? undefined : windows.get(sessionId)?.get(principalId);
      if (principalId !== undefined && !win) return 0;
      return transcriptEntries((entries.get(sessionId) ?? []).filter((e) => !win || entryWithinTenure(e, win))).filter(
        (e) => e.seq < beforeSeq,
      ).length;
    },

    async getContextWindow(sessionId) {
      return contextWindowFromEntries(entries.get(sessionId) ?? []);
    },

    async getEntry(sessionId, seq) {
      return (entries.get(sessionId) ?? []).find((e) => e.seq === seq);
    },

    async latestEntrySeq(sessionId) {
      return (entries.get(sessionId)?.length ?? 0) - 1;
    },

    async goals(sessionIds) {
      const found = new Map<string, GoalRecord>();
      for (const id of sessionIds) {
        const goal = goals.get(id);
        if (goal) found.set(id, structuredClone(goal));
      }
      return found;
    },

    async setGoal(lease, goal, notices = []) {
      const held = leases.get(lease.sessionId);
      if (!held || held.token !== lease.token || now() >= held.expiresAt) {
        throw new Error("set goal without a valid session lease");
      }
      if (!sessions.has(lease.sessionId)) throw new Error(`unknown session: ${lease.sessionId}`);
      if (notices.length) await this.appendMany(lease, notices);
      goals.set(lease.sessionId, structuredClone(goal));
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
      llmRequestSeq.set(full.id, ++llmRequestCount);
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
        if (opts?.omitRequest) return { ...r };
        const body = r.promptHash != null ? promptEnvelopes.get(r.promptHash) : undefined;
        return body !== undefined ? { ...r, promptEnvelope: JSON.parse(body) } : { ...r };
      });
    },

    async listScreenSamples(limit) {
      const wanted = Math.max(0, Math.trunc(limit));
      if (!wanted) return [];
      const samples = [...llmRequests.values()].flat().flatMap((r) => {
        if (r.step !== SECURITY_SCREEN_STEP || r.promptHash == null) return [];
        const body = promptEnvelopes.get(r.promptHash);
        const payload = body === undefined ? null : screenPayloadFromEnvelope(JSON.parse(body));
        return payload
          ? [
              {
                id: r.id,
                sessionId: r.sessionId,
                scopeLabel: r.scopeLabel,
                createdAt: r.createdAt,
                model: r.model,
                payload,
              },
            ]
          : [];
      });
      return samples
        .sort((a, b) => b.createdAt - a.createdAt || (llmRequestSeq.get(b.id) ?? 0) - (llmRequestSeq.get(a.id) ?? 0))
        .slice(0, wanted);
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

    async listByParticipant(principalId, opts) {
      const ids = participants.get(principalId);
      if (!ids) return [];
      const out: Session[] = [];
      for (const id of ids) {
        const row = participantSession(id, principalId);
        if (!row) continue;
        const { spawnMeta: _spawnMeta, clientTools: _clientTools, ...listed } = row;
        out.push(listed);
      }
      return opts
        ? out
            .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
            .slice(0, Math.max(0, Math.floor(opts.limit)))
        : out;
    },

    async participantScopes(principalId) {
      const byScope = new Map<ScopeId, ParticipantScope>();
      for (const id of participants.get(principalId) ?? []) {
        const row = participantSession(id, principalId);
        if (!row || row.incognito) continue;
        const scope = byScope.get(row.scopeId) ?? { scopeId: row.scopeId, sessionCount: 0, lastActivityAt: null };
        if (!scope.channelName && row.channelName) scope.channelName = row.channelName;
        if (row.hasEntries !== false || Boolean(row.title?.trim())) {
          scope.sessionCount++;
          scope.lastActivityAt = Math.max(scope.lastActivityAt ?? 0, row.lastActivityAt ?? row.createdAt);
        }
        byScope.set(row.scopeId, scope);
      }
      return [...byScope.values()];
    },

    async listParticipantPage(principalId, query): Promise<ParticipantPage> {
      const automation = new Set(["cron", "webhook", "loop"]);
      const title = query.titleQuery?.trim().toLowerCase();
      const ids = query.sessionIds ? new Set(query.sessionIds) : null;
      const key = (s: Session): [number, string] => [s.lastActivityAt ?? s.createdAt, s.id];
      const after = (s: Session): boolean => {
        if (!query.before) return true;
        const [activity, id] = key(s);
        return activity < query.before.activity || (activity === query.before.activity && id < query.before.id);
      };
      const rows = [...(participants.get(principalId) ?? [])]
        .map((id) => participantSession(id, principalId))
        .filter((s): s is Session => s !== null)
        .filter(
          (s) =>
            !s.parentSessionId &&
            !s.incognito &&
            !(s.surface && automation.has(s.surface)) &&
            ((entries.get(s.id)?.length ?? 0) > 0 || Boolean(s.title?.trim())) &&
            Boolean(s.archived) === (query.archived === true) &&
            (query.pinned === undefined || Boolean(s.pinned) === query.pinned) &&
            (query.surface === undefined || s.surface === query.surface) &&
            (query.scopeId === undefined || s.scopeId === query.scopeId) &&
            (!ids || ids.has(s.id)) &&
            (!title || `${s.title ?? ""} ${s.channelName ?? ""}`.toLowerCase().includes(title)) &&
            after(s),
        )
        .sort((a, b) => {
          const [aa, ai] = key(a);
          const [ba, bi] = key(b);
          if (ba !== aa) return ba - aa;
          if (bi === ai) return 0;
          return bi < ai ? -1 : 1;
        })
        .map(({ spawnMeta: _spawnMeta, clientTools: _clientTools, ...listed }) => listed);
      const limit = Math.max(1, Math.min(Math.floor(query.limit), 200));
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        sessions: page,
        next: rows.length > limit && last ? { activity: key(last)[0], id: last.id } : null,
      };
    },

    async descendantsOf(rootIds): Promise<SessionDescendant[]> {
      const out: SessionDescendant[] = [];
      const seen = new Set(rootIds);
      let frontier = rootIds.map((id) => ({ id, rootId: id }));
      while (frontier.length) {
        const next: { id: string; rootId: string }[] = [];
        for (const s of sessions.values()) {
          const parent = frontier.find((f) => f.id === s.parentSessionId);
          if (!parent || seen.has(s.id)) continue;
          seen.add(s.id);
          out.push({ id: s.id, rootId: parent.rootId, threadRef: s.threadRef });
          next.push({ id: s.id, rootId: parent.rootId });
        }
        frontier = next;
      }
      return out;
    },

    async listDescendantsForParticipant(rootId, principalId, limit) {
      const ids = (await this.descendantsOf([rootId])).map((d) => d.id).slice(0, Math.max(0, Math.floor(limit)));
      return ids
        .filter((id) => participants.get(principalId)?.has(id))
        .map((id) => participantSession(id, principalId))
        .filter((s): s is Session => s !== null)
        .map(({ spawnMeta: _spawnMeta, clientTools: _clientTools, ...listed }) => listed)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    },

    async getForParticipant(sessionId, principalId) {
      if (!participants.get(principalId)?.has(sessionId)) return null;
      return participantSession(sessionId, principalId);
    },

    async updateParticipantView(sessionId, principalId, patch) {
      const view = windows.get(sessionId)?.get(principalId);
      if (!view) return;
      if (patch.title !== undefined) view.title = patch.title;
      if (patch.archived !== undefined) view.archived = patch.archived;
      if (patch.pinned !== undefined) view.pinned = patch.pinned;
      if (patch.color !== undefined) view.color = patch.color;
      if (patch.readAt !== undefined) view.readAt = patch.readAt;
    },

    async addPin(sessionId, pin: NewSessionPin, maxPins?: number): Promise<SessionPin | null> {
      if (!sessions.has(sessionId)) return null;
      const list = pins.get(sessionId) ?? [];
      if (maxPins !== undefined && list.length >= maxPins) return null;
      const rec: SessionPin = { ...pin, id: randomUUID(), sessionId, createdAt: now() };
      list.push(rec);
      pins.set(sessionId, list);
      return { ...rec };
    },

    async listPins(sessionId): Promise<SessionPin[]> {
      return (pins.get(sessionId) ?? []).map((p) => ({ ...p }));
    },

    async removePin(sessionId, pinId): Promise<boolean> {
      const list = pins.get(sessionId);
      if (!list) return false;
      const next = list.filter((p) => p.id !== pinId);
      if (next.length === list.length) return false;
      pins.set(sessionId, next);
      return true;
    },

    async visibleEntries(sessionId, principalId, opts?: GetEntriesOptions) {
      const win = windows.get(sessionId)?.get(principalId);
      if (!win) return [];
      const all = (entries.get(sessionId) ?? []).filter((e) => entryWithinTenure(e, win));
      const visible = (opts?.transcript ? transcriptEntries(all) : all).filter(
        (e) => e.seq >= (opts?.sinceSeq ?? 0) && (opts?.beforeSeq === undefined || e.seq < opts.beforeSeq),
      );
      return opts?.limit !== undefined ? visible.slice(-opts.limit) : visible;
    },

    async searchSessionTitles(principalId, query, limit = 20): Promise<Session[]> {
      const needle = query.trim();
      if (needle.length < 2) return [];
      const lower = needle.toLowerCase();
      const ids = participants.get(principalId);
      if (!ids) return [];
      const out: Session[] = [];
      for (const id of ids) {
        const row = participantSession(id, principalId);
        if (!row || row.incognito) continue;
        if ((row.title ?? "").toLowerCase().includes(lower)) out.push(row);
      }
      return out
        .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
        .slice(0, Math.max(1, Math.min(Math.floor(limit), 100)));
    },

    async searchEntries(principalId, query, limit = 40): Promise<EntrySearchHit[]> {
      const terms = searchTerms(query);
      if (!terms.length) return [];
      const hits: EntrySearchHit[] = [];
      for (const sessionId of participants.get(principalId) ?? []) {
        const win = windows.get(sessionId)?.get(principalId);
        if (!win) continue;
        const indexed = searchIndex.get(sessionId) ?? [];
        const session = sessions.get(sessionId);
        if (!session || session.incognito) continue;
        for (const row of indexed) {
          if (!entryWithinTenure(row, win)) continue;
          const entry = entries.get(sessionId)?.[row.seq];
          if (!entry) continue;
          if (!matchesSearchTerms(row.text, terms)) continue;
          hits.push({
            sessionId,
            scopeId: session.scopeId,
            ...((win.title ?? session.title) != null ? { title: win.title ?? session.title } : {}),
            ...(session.channelName ? { channelName: session.channelName } : {}),
            ...(session.surface ? { surface: session.surface } : {}),
            ...(win.archived ? { archived: true } : {}),
            seq: row.seq,
            type: row.type,
            ...(row.author ? { author: row.author } : {}),
            text: row.text,
            createdAt: row.createdAt,
          });
        }
      }
      hits.sort((a, b) => b.createdAt - a.createdAt || idDesc(a.sessionId, b.sessionId) || b.seq - a.seq);
      return hits.slice(0, Math.max(1, Math.min(limit, 200)));
    },

    async scanAll() {
      return [...sessions.values()];
    },

    async countSessions() {
      return sessions.size;
    },

    async listByScope(scope) {
      return [...sessions.values()]
        .filter((s) => s.scopeId === scope)
        .sort((a, b) => b.createdAt - a.createdAt || idDesc(a.id, b.id));
    },

    async scopeHasSessions(scope) {
      return [...sessions.values()].some((s) => s.scopeId === scope);
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

    async scopeSessionSummaries(scope, orgWide, page: SessionPage): Promise<SessionSummary[]> {
      const out: SessionSummary[] = [];
      for (const s of sessions.values()) {
        if (!orgWide && s.scopeId !== scope) continue;
        const origin = sessionOrigin(s.threadRef);
        if (page.category && sessionCategory(origin) !== page.category) continue;
        if (
          page.origin === "other_background"
            ? origin === "conversation" || origin === "cron"
            : page.origin && origin !== page.origin
        )
          continue;
        if (page.cronId && cronIdOf(s.threadRef) !== page.cronId) continue;
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
          firstMessage: userEntries.length ? userMessagePreview(userEntries[0]!.payload) : (s.title ?? ""),
          lastMessage: userEntries.length ? userMessagePreview(userEntries[userEntries.length - 1]!.payload, 100) : "",
        });
      }
      out.sort((a, b) => b.lastActivity - a.lastActivity || idDesc(a.id, b.id));
      const before = page.before;
      return (
        before
          ? out.filter(
              (r) =>
                r.lastActivity < before.lastActivity || (r.lastActivity === before.lastActivity && r.id < before.id),
            )
          : out
      ).slice(0, page.limit);
    },

    async scopeConversationCount(scope): Promise<number> {
      let n = 0;
      for (const s of sessions.values()) if (s.scopeId === scope && sessionOrigin(s.threadRef) === "conversation") n++;
      return n;
    },

    async scopeActivity(): Promise<ScopeActivity[]> {
      const byScope = new Map<string, ScopeActivity>();
      for (const s of sessions.values()) {
        const r = byScope.get(s.scopeId) ?? {
          scopeId: s.scopeId,
          conversations: 0,
          crons: 0,
          background: 0,
          lastActivity: 0,
        };
        byScope.set(s.scopeId, r);
        const log = entries.get(s.id) ?? [];
        r.lastActivity = Math.max(r.lastActivity, log.length ? log[log.length - 1]!.createdAt : s.createdAt);
        const origin = sessionOrigin(s.threadRef);
        if (origin === "conversation") r.conversations++;
        else if (origin === "cron") r.crons++;
        else r.background++;
      }
      return [...byScope.values()];
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
            if (!entryWithinTenure(e, w)) continue;
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

    async spendRollup(range): Promise<SpendRow[]> {
      const DAY = 86_400_000;
      const buckets = new Map<string, SpendRow>();
      for (const [sessionId, records] of llmRequests) {
        const session = sessions.get(sessionId);
        if (!session) continue;
        let origin = sessionOrigin(session.threadRef);
        let ancestor = session;
        const visited = new Set([sessionId]);
        while (origin === "conversation" && ancestor.parentSessionId && visited.size < 64) {
          const parent = sessions.get(ancestor.parentSessionId);
          if (!parent || visited.has(parent.id)) break;
          visited.add(parent.id);
          ancestor = parent;
          origin = sessionOrigin(parent.threadRef);
        }
        const cronId = cronIdOf(ancestor.threadRef);
        for (const r of records) {
          if (!r.usage) continue;
          if (r.createdAt < range.from || r.createdAt >= range.to) continue;
          const day = Math.floor(r.createdAt / DAY);
          const model = r.model ?? null;
          const key = JSON.stringify([day, session.scopeId, origin, cronId, model]);
          let row = buckets.get(key);
          if (!row) {
            row = {
              day,
              model,
              scopeId: session.scopeId,
              origin,
              cronId,
              calls: 0,
              costUsd: 0,
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            };
            buckets.set(key, row);
          }
          row.calls += 1;
          row.costUsd += r.usage.costUsd;
          row.input += r.usage.input;
          row.output += r.usage.output;
          row.cacheRead += r.usage.cacheRead;
          row.cacheWrite += r.usage.cacheWrite;
        }
      }
      return [...buckets.values()];
    },

    async listParticipants() {
      const out: ParticipantWindow[] = [];
      for (const [sessionId, byPrincipal] of windows) {
        for (const [principalId, w] of byPrincipal) out.push(toParticipantWindow(sessionId, principalId, w));
      }
      return out;
    },

    async distinctParticipants() {
      const out = new Set<string>();
      for (const byPrincipal of windows.values()) for (const principalId of byPrincipal.keys()) out.add(principalId);
      return [...out];
    },

    async participantWindowsOf(sessionId) {
      const out: ParticipantWindow[] = [];
      for (const [principalId, w] of windows.get(sessionId) ?? []) {
        out.push(toParticipantWindow(sessionId, principalId, w));
      }
      return out;
    },

    async participantsOf(sessionId) {
      return [...(windows.get(sessionId)?.keys() ?? [])];
    },
  };
}
