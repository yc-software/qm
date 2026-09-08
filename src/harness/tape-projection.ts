import type { EntryType, ScopeId, SessionEntry } from "../types.ts";
import type { GetEntriesOptions, Lease, NewSearchEntry, SessionStore, TapeRecord } from "../sessions/session-store.ts";
import { entryWithinTenure, TAPE_RENDER_VERSION } from "../sessions/session-store.ts";
import { entrySearchAuthor, entrySearchText, SEARCHABLE_ENTRY_TYPES } from "../sessions/entry-search.ts";
import { deliveryNoteManifest, legacyDeliveryNoteManifest } from "../core/attachments.ts";
import { createContextSummaryPayload } from "../sessions/session-store.ts";
import { assistantDroppedAtReplay } from "./tape-fold.ts";
import { textFromContent, thinkingBlocksFromContent } from "./pi-harness.ts";
import { swallow } from "../util/errors.ts";

const UNSERVABLE_MEMO_CAP = 10_000;
const SUFFIX_ROW_CAP_MIN = 100;
const SUFFIX_ROW_CAP_MAX = 5_000;

interface DraftEntry {
  type: EntryType;
  payload: unknown;
  scopeLabel: ScopeId;
  createdAt: number;
  exact?: number;
  mirror?: boolean;
}

type DraftEvent =
  | { kind: "item"; item: DraftEntry }
  | { kind: "bound"; seq: number; mirrorRequired?: boolean; spanStart?: number }
  | { kind: "coarse" };

interface TapeMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
}

interface BoundAnnotation {
  seq: number;
  mirror: DraftEntry | null;
  spanStart?: number;
}

function toolCallBlocks(content: unknown): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const c of content) {
    const b = c as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
    if (b?.type !== "toolCall" || typeof b.id !== "string") continue;
    const args =
      b.arguments && typeof b.arguments === "object" && !Array.isArray(b.arguments)
        ? (b.arguments as Record<string, unknown>)
        : {};
    out.push({ id: b.id, name: typeof b.name === "string" ? b.name : "tool", arguments: args });
  }
  return out;
}

function contextEventName(row: TapeRecord): string | null {
  if (row.kind !== "context_event") return null;
  const event = (row.payload as { event?: unknown } | null)?.event;
  return typeof event === "string" ? event : null;
}

export const RENDER_IMPORT_EVENT = "render_import";

export function renderableTapeSlice(rows: readonly TapeRecord[]): readonly TapeRecord[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (contextEventName(row) !== RENDER_IMPORT_EVENT) continue;
    const firstTapeSeq = (row.payload as { firstTapeSeq?: unknown }).firstTapeSeq;
    if (typeof firstTapeSeq === "number") {
      const start = rows.findIndex((r) => r.seq >= firstTapeSeq);
      if (start >= 0 && start <= i) return rows.slice(start);
    }
    return rows;
  }
  return rows;
}

function tapeHasRenderBlockers(rows: readonly TapeRecord[]): boolean {
  return renderableTapeSlice(rows).some((row) => {
    const event = contextEventName(row);
    return event === "legacy_import" || event === "legacy_patch";
  });
}

function entryMirror(row: TapeRecord): DraftEntry | null {
  const mirrored = (row.payload as { entry?: { type?: unknown; payload?: unknown; at?: unknown } } | null)?.entry;
  if (!mirrored || typeof mirrored.type !== "string" || row.entrySeq === undefined) return null;
  return {
    type: mirrored.type as EntryType,
    payload: mirrored.payload ?? null,
    scopeLabel: row.scopeLabel,
    createdAt: typeof mirrored.at === "number" ? mirrored.at : row.createdAt,
    exact: row.entrySeq,
    mirror: true,
  };
}

function boundAnnotation(row: TapeRecord): BoundAnnotation | null | "unstamped" {
  if (row.kind !== "annotation") return null;
  const payload = row.payload as {
    turnEnd?: unknown;
    subturnEnd?: unknown;
    render?: unknown;
    spanStart?: unknown;
  } | null;
  if (payload?.turnEnd !== true && payload?.subturnEnd !== true) return null;
  if (row.entrySeq === undefined) return "unstamped";
  if (payload.render !== TAPE_RENDER_VERSION) return "unstamped";
  return {
    seq: row.entrySeq,
    mirror: entryMirror(row),
    ...(typeof payload.spanStart === "number" ? { spanStart: payload.spanStart } : {}),
  };
}

function userDraft(row: TapeRecord, isTrigger: boolean): DraftEntry | null {
  const meta = row.meta;
  const message = row.payload as TapeMessage;
  const createdAt = meta?.entryCreatedAt ?? row.createdAt;
  const exact = row.entrySeq !== undefined ? { exact: row.entrySeq } : {};
  if (meta?.overheard) {
    return {
      type: "user",
      payload: {
        overheard: true,
        ...(meta.ts ? { ts: meta.ts } : {}),
        ...(meta.changeTime ? { changeTime: meta.changeTime } : {}),
        ...(meta.author ? { name: meta.author } : {}),
        text: meta.bareText ?? textFromContent(message.content),
        ...(meta.attachments?.length ? { files: meta.attachments } : {}),
        ...(meta.securityTainted ? { securityTainted: true } : {}),
      },
      scopeLabel: row.scopeLabel,
      createdAt,
      ...exact,
    };
  }
  if (meta?.bareText !== undefined) {
    return {
      type: "user",
      payload: {
        text: meta.bareText,
        ...(meta.ts ? { ts: meta.ts } : {}),
        ...(meta.author ? { name: meta.author } : {}),
        ...(meta.display ? { display: meta.display } : {}),
        ...(meta.hidden ? { hidden: true } : {}),
        ...(meta.securityTainted ? { securityTainted: true } : {}),
        ...(meta.attachments?.length ? { attachments: meta.attachments } : {}),
        ...(isTrigger ? {} : { steered: true }),
      },
      scopeLabel: row.scopeLabel,
      createdAt,
      ...exact,
    };
  }
  if (meta?.hidden) {
    const noteText = textFromContent(message.content);
    const manifest = deliveryNoteManifest(noteText) ?? legacyDeliveryNoteManifest(noteText);
    if (manifest !== null) {
      return {
        type: "delivery",
        payload: {
          text: manifest,
          ...(meta.attachments?.length ? { files: meta.attachments } : {}),
        },
        scopeLabel: row.scopeLabel,
        createdAt,
        ...exact,
      };
    }
  }
  return null;
}

function toolResultDraft(row: TapeRecord): DraftEntry | null {
  if (row.entrySeq !== undefined) return null;
  const message = row.payload as TapeMessage;
  if (typeof message.toolCallId !== "string") return null;
  return {
    type: "tool_result",
    payload: {
      tool: typeof message.toolName === "string" ? message.toolName : "tool",
      callId: message.toolCallId,
      isError: message.isError === true,
      result: textFromContent(message.content),
    },
    scopeLabel: row.scopeLabel,
    createdAt: row.createdAt,
  };
}

export interface TapeProjection {
  entries: SessionEntry[];
  coveredSeq: number;
  baseSeq: number;
}

export function projectTapeEntries(
  sessionId: string,
  tapeRows: readonly TapeRecord[],
  opts?: { anchored?: boolean; openTail?: boolean },
): TapeProjection | null {
  const sliced = renderableTapeSlice(tapeRows);
  let rows = sliced;
  let base = -1;
  if (opts?.anchored) {
    const anchorAt = sliced.findIndex((row) => {
      const bound = boundAnnotation(row);
      return bound !== null && bound !== "unstamped";
    });
    if (anchorAt < 0) return null;
    const anchor = boundAnnotation(sliced[anchorAt]!) as BoundAnnotation;
    base = anchor.seq;
    rows = sliced.slice(anchorAt + 1);
  }

  const events: DraftEvent[] = [];
  let sawTrigger = false;
  let coarseReplyMirrorPending = false;
  for (const row of rows) {
    const eventName = contextEventName(row);
    if (eventName === "legacy_import" || eventName === "legacy_patch") return null;

    if (row.kind === "annotation") {
      const bound = boundAnnotation(row);
      if (bound === "unstamped") return null;
      if (bound) {
        if (bound.mirror) events.push({ kind: "item", item: bound.mirror });
        events.push({
          kind: "bound",
          seq: bound.seq,
          mirrorRequired: !bound.mirror && coarseReplyMirrorPending,
          ...(bound.spanStart !== undefined ? { spanStart: bound.spanStart } : {}),
        });
        coarseReplyMirrorPending = false;
        sawTrigger = false;
        continue;
      }
      const mirror = entryMirror(row);
      if (mirror) events.push({ kind: "item", item: mirror });
      continue;
    }

    if (row.kind === "context_event") {
      if (eventName === "compaction") {
        const text = (row.payload as { text?: unknown }).text;
        events.push({
          kind: "item",
          item: {
            type: "system",
            payload: {
              ...createContextSummaryPayload(row.coversEntrySeq ?? -1, typeof text === "string" ? text : ""),
              ...(row.meta?.securityTainted ? { securityTainted: true } : {}),
            },
            scopeLabel: row.scopeLabel,
            createdAt: row.meta?.entryCreatedAt ?? row.createdAt,
            ...(row.entrySeq !== undefined ? { exact: row.entrySeq } : {}),
          },
        });
      }
      continue;
    }

    if (row.harness !== undefined && row.harness !== "pi") {
      events.push({ kind: "coarse" });
      coarseReplyMirrorPending = true;
      if (row.entrySeq !== undefined && (row.meta?.bareText !== undefined || row.meta?.overheard)) {
        const isTrigger = !sawTrigger && row.meta?.bareText !== undefined && !row.meta?.overheard;
        const draft = userDraft(row, isTrigger);
        if (draft && draft.exact !== undefined) {
          if (isTrigger) sawTrigger = true;
          events.push({ kind: "item", item: draft });
        }
      }
      continue;
    }

    const message = row.payload as TapeMessage | null;
    if (!message || typeof message !== "object") return null;
    if (message.role === "user") {
      const isTrigger = !sawTrigger && row.meta?.bareText !== undefined && !row.meta?.overheard;
      const draft = userDraft(row, isTrigger);
      if (!draft) continue;
      if (isTrigger) sawTrigger = true;
      events.push({ kind: "item", item: draft });
    } else if (message.role === "assistant") {
      for (const block of thinkingBlocksFromContent(message.content)) {
        events.push({
          kind: "item",
          item: { type: "thinking", payload: block, scopeLabel: row.scopeLabel, createdAt: row.createdAt },
        });
      }
      const calls = toolCallBlocks(message.content);
      if (!calls.length) continue;
      const text = textFromContent(message.content).trim();
      if (text) {
        events.push({
          kind: "item",
          item: { type: "text", payload: { text }, scopeLabel: row.scopeLabel, createdAt: row.createdAt },
        });
      }
      if (assistantDroppedAtReplay(message)) continue;
      for (const call of calls) {
        events.push({
          kind: "item",
          item: {
            type: "tool_call",
            payload: { ...call.arguments, tool: call.name, callId: call.id },
            scopeLabel: row.scopeLabel,
            createdAt: row.createdAt,
          },
        });
      }
    } else if (message.role === "toolResult") {
      const draft = toolResultDraft(row);
      if (draft) events.push({ kind: "item", item: draft });
    } else {
      return null;
    }
  }

  const lastBound = events.findLastIndex((event) => event.kind === "bound");
  if (lastBound < 0 && !opts?.openTail) return { entries: [], coveredSeq: base, baseSeq: base };
  const settled = opts?.openTail ? events : events.slice(0, lastBound + 1);

  const out: SessionEntry[] = [];
  let nextMin = base + 1;
  let coveredSeq = base;
  const push = (item: DraftEntry, seq: number): void => {
    out.push({
      sessionId,
      seq,
      parentSeq: seq === 0 ? null : seq - 1,
      type: item.type,
      payload: item.payload,
      scopeLabel: item.scopeLabel,
      createdAt: item.createdAt,
    });
  };
  let run: DraftEntry[] = [];
  const pushedSeqs = new Set<number>();
  const fillRun = (slots: number): boolean => {
    if (slots < 0 || run.length !== slots) return false;
    for (const item of run) {
      pushedSeqs.add(nextMin);
      push(item, nextMin++);
    }
    run = [];
    return true;
  };
  let coarseRun = false;
  const pushedExact = new Set<number>();
  const mirrorInvolved = new Set<number>();
  for (const event of settled) {
    if (event.kind === "coarse") {
      coarseRun = true;
      continue;
    }
    if (event.kind === "bound") {
      if (event.mirrorRequired && !pushedExact.has(event.seq)) return null;
      if (coarseRun && run.length === 0) nextMin = Math.max(nextMin, event.seq + 1);
      else if (!fillRun(event.seq + 1 - nextMin)) return null;
      if (event.spanStart !== undefined) {
        for (let seq = Math.max(event.spanStart, base + 1); seq <= event.seq; seq++) {
          if (!pushedSeqs.has(seq)) return null;
        }
      }
      coarseRun = false;
      coveredSeq = Math.max(coveredSeq, event.seq);
      continue;
    }
    if (event.item.exact !== undefined) {
      const seq = event.item.exact;
      if (run.length === 0 && pushedExact.has(seq) && (event.item.mirror === true || mirrorInvolved.has(seq))) {
        continue;
      }
      if (coarseRun && run.length === 0 && seq >= nextMin) nextMin = seq;
      else if (!fillRun(seq - nextMin)) return null;
      push(event.item, seq);
      pushedExact.add(seq);
      pushedSeqs.add(seq);
      if (event.item.mirror === true) mirrorInvolved.add(seq);
      nextMin = seq + 1;
      continue;
    }
    run.push(event.item);
  }
  if (opts?.openTail) fillRun(run.length);
  return { entries: out, coveredSeq, baseSeq: base };
}

export type TranscriptStore = Pick<
  SessionStore,
  "getEntries" | "visibleEntries" | "getTape" | "latestEntrySeq" | "participantWindowsOf"
>;

interface TranscriptRead {
  entries: SessionEntry[];
  earlier: number;
}

export interface TranscriptSource {
  forRender(sessionId: string, opts?: GetEntriesOptions): Promise<TranscriptRead>;
  forViewer(sessionId: string, principalId: string, opts?: { limit?: number }): Promise<TranscriptRead>;
}

function createUnservableMemo() {
  const ids = new Set<string>();
  return {
    has: (sessionId: string): boolean => ids.has(sessionId),
    remember(sessionId: string): void {
      if (ids.size >= UNSERVABLE_MEMO_CAP) ids.clear();
      ids.add(sessionId);
    },
  };
}

const unservableTapes = createUnservableMemo();

interface ProjectedRead {
  entries: SessionEntry[];
  anchored: boolean;
  base: number;
}

export function createTranscriptSource(sessions: TranscriptStore): TranscriptSource {
  const projected = async (sessionId: string, limit?: number): Promise<ProjectedRead | null> => {
    if (unservableTapes.has(sessionId)) return null;
    try {
      let rows: TapeRecord[];
      let anchored = false;
      if (limit !== undefined) {
        const cap = Math.min(Math.max(limit * 2, SUFFIX_ROW_CAP_MIN), SUFFIX_ROW_CAP_MAX);
        rows = await sessions.getTape(sessionId, { limit: cap });
        anchored = rows.length >= cap;
      } else {
        rows = await sessions.getTape(sessionId);
      }
      if (!anchored && tapeHasRenderBlockers(rows)) {
        unservableTapes.remember(sessionId);
        return null;
      }
      const projection = projectTapeEntries(sessionId, rows, { anchored });
      if (!projection) return null;
      if (anchored && projection.entries.length < limit!) return null;
      if (projection.coveredSeq >= (await sessions.latestEntrySeq(sessionId))) {
        return { entries: projection.entries, anchored, base: projection.baseSeq };
      }
      const archivedSeq = (await sessions.getEntries(sessionId, { limit: 1 }))[0]?.seq ?? -1;
      if (archivedSeq < 0 && rows.length === 0) return { entries: [], anchored: false, base: -1 };
      if (projection.coveredSeq < archivedSeq) return null;
      return { entries: projection.entries, anchored, base: projection.baseSeq };
    } catch (err) {
      swallow("tape-projection: read", err);
      return null;
    }
  };

  return {
    async forRender(sessionId, opts?): Promise<TranscriptRead> {
      const read = await projected(sessionId, opts?.limit);
      if (read === null) {
        const rows = await sessions.getEntries(sessionId, opts);
        return { entries: rows, earlier: rows[0]?.seq ?? 0 };
      }
      const since = opts?.sinceSeq !== undefined ? read.entries.filter((e) => e.seq >= opts.sinceSeq!) : read.entries;
      const entries = opts?.limit !== undefined ? since.slice(-opts.limit) : since;
      const below = read.anchored ? read.base + 1 : 0;
      return { entries, earlier: read.entries.length - entries.length + below };
    },
    async forViewer(sessionId, principalId, opts?): Promise<TranscriptRead> {
      const fallback = async (): Promise<TranscriptRead> => ({
        entries: await sessions.visibleEntries(sessionId, principalId),
        earlier: 0,
      });
      let windows;
      try {
        windows = await sessions.participantWindowsOf(sessionId);
      } catch (err) {
        swallow("tape-projection: participant windows", err);
        return fallback();
      }
      const window = windows.find((w) => w.principalId === principalId);
      if (!window) return { entries: [], earlier: 0 };
      if (window.validFromSeq === null || (window.validTo !== null && window.validToSeq === null)) {
        return fallback();
      }
      const limit = window.validToSeq === null ? opts?.limit : undefined;
      let read = await projected(sessionId, limit);
      if (read === null) return fallback();
      let filtered = read.entries.filter((e) => entryWithinTenure(e, window));
      if (limit !== undefined && filtered.length < limit && (read.entries[0]?.seq ?? 0) > window.validFromSeq) {
        read = await projected(sessionId);
        if (read === null) return fallback();
        filtered = read.entries.filter((e) => entryWithinTenure(e, window));
      }
      if (limit === undefined) return { entries: filtered, earlier: 0 };
      const below = read.anchored ? Math.max(0, read.base + 1 - window.validFromSeq) : 0;
      return { entries: filtered.slice(-limit), earlier: Math.max(0, filtered.length - limit) + below };
    },
  };
}

export interface ProjectedHistory {
  rows: TapeRecord[];
  entries: SessionEntry[];
  latestSeq: number;
  fromArchive: boolean;
}

export async function projectedSessionHistory(
  sessions: Pick<SessionStore, "getTape" | "getEntries" | "latestEntrySeq">,
  sessionId: string,
  rows?: TapeRecord[],
): Promise<ProjectedHistory> {
  const tapeRows = rows ?? (await sessions.getTape(sessionId));
  const projection = projectTapeEntries(sessionId, tapeRows, { openTail: true });
  const latestSeq = await sessions.latestEntrySeq(sessionId);
  if (projection && (projection.entries.at(-1)?.seq ?? -1) >= latestSeq) {
    return { rows: tapeRows, entries: projection.entries, latestSeq, fromArchive: false };
  }
  if (tapeRows.length > 0) {
    console.error(
      `[tape-projection] session ${sessionId} history fell back to the entries archive despite ${tapeRows.length} tape rows (projected through ${projection?.entries.at(-1)?.seq ?? -1}, latest ${latestSeq}) — tape-only turns are invisible to this read`,
    );
  }
  return { rows: tapeRows, entries: await sessions.getEntries(sessionId), latestSeq, fromArchive: true };
}
export function searchRowsFromEntries(entries: readonly SessionEntry[], sinceSeq: number): NewSearchEntry[] {
  return entries.flatMap((entry) => {
    if (entry.seq <= sinceSeq || !SEARCHABLE_ENTRY_TYPES.has(entry.type)) return [];
    const text = entrySearchText(entry.payload);
    if (!text || !text.trim()) return [];
    const author = entrySearchAuthor(entry);
    return [
      {
        seq: entry.seq,
        type: entry.type,
        ...(author ? { author } : {}),
        text,
        createdAt: entry.createdAt,
      },
    ];
  });
}

export interface SearchIndexSync {
  servable: boolean;
  indexed: number;
  coveredSeq: number;
}

const SEARCH_SYNC_ROW_CAP = 500;

function stampedFinalEntries(sessionId: string, rows: readonly TapeRecord[]): SessionEntry[] {
  const finals: SessionEntry[] = [];
  const pushFinal = (draft: DraftEntry): void => {
    if (draft.exact === undefined) return;
    finals.push({
      sessionId,
      seq: draft.exact,
      parentSeq: draft.exact === 0 ? null : draft.exact - 1,
      type: draft.type,
      payload: draft.payload,
      scopeLabel: draft.scopeLabel,
      createdAt: draft.createdAt,
    });
  };
  for (const row of rows) {
    if (row.kind === "message") {
      if (row.entrySeq === undefined) continue;
      const message = row.payload as TapeMessage | null;
      if (!message || typeof message !== "object" || message.role !== "user") continue;
      const draft = userDraft(row, true);
      if (draft) pushFinal(draft);
      continue;
    }
    if (row.kind !== "annotation") continue;
    const mirror = entryMirror(row);
    if (mirror) pushFinal(mirror);
  }
  return finals.sort((a, b) => a.seq - b.seq);
}

export async function syncSearchIndex(
  sessions: Pick<SessionStore, "getTape" | "appendSearchEntries" | "searchIndexCoverage">,
  lease: Lease,
): Promise<SearchIndexSync> {
  const watermark = await sessions.searchIndexCoverage(lease.sessionId);
  if (unservableTapes.has(lease.sessionId)) return { servable: false, indexed: 0, coveredSeq: watermark };
  let fullRows: TapeRecord[] | null = null;
  let readRows: TapeRecord[] = [];
  const projection = await (async () => {
    const suffix = await sessions.getTape(lease.sessionId, { limit: SEARCH_SYNC_ROW_CAP });
    readRows = suffix;
    if (suffix.length < SEARCH_SYNC_ROW_CAP) {
      fullRows = suffix;
      return projectTapeEntries(lease.sessionId, suffix);
    }
    const anchored = projectTapeEntries(lease.sessionId, suffix, { anchored: true });
    if (anchored && anchored.baseSeq <= watermark) return anchored;
    fullRows = await sessions.getTape(lease.sessionId);
    readRows = fullRows;
    return projectTapeEntries(lease.sessionId, fullRows);
  })();
  if (!projection) {
    if (fullRows !== null && tapeHasRenderBlockers(fullRows)) unservableTapes.remember(lease.sessionId);
    return { servable: false, indexed: 0, coveredSeq: watermark };
  }
  const fresh = searchRowsFromEntries(projection.entries, watermark);
  let tailCursor = Math.max(watermark, projection.coveredSeq);
  for (const entry of stampedFinalEntries(lease.sessionId, readRows)) {
    if (entry.seq <= tailCursor) continue;
    if (entry.seq !== tailCursor + 1) break;
    fresh.push(...searchRowsFromEntries([entry], tailCursor));
    tailCursor = entry.seq;
  }
  if (fresh.length) await sessions.appendSearchEntries(lease, fresh);
  return { servable: true, indexed: fresh.length, coveredSeq: projection.coveredSeq };
}
