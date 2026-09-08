import type { ScopeId, SessionEntry } from "../types.ts";
import type { Lease, NewEntry, NewTapeRecord, SessionStore, TapeRecord } from "../sessions/session-store.ts";
import {
  createEntryAllocator,
  TAPE_RENDER_VERSION,
  tapeCheckpointPayload,
  tapeEntryMirrorRecord,
  type TranscriptAppendSessions,
} from "../sessions/session-store.ts";
import { projectedSessionHistory, projectTapeEntries, RENDER_IMPORT_EVENT } from "./tape-projection.ts";
import { appendCoverageImport } from "./replay.ts";
import { canonicalJson } from "../util/objects.ts";

export async function appendRenderImport(
  store: Pick<SessionStore, "appendTape">,
  lease: Lease,
  entries: readonly SessionEntry[],
  scopeLabel: ScopeId,
  needsFoldImport: boolean,
): Promise<"imported" | "unservable-fold"> {
  const last = entries[entries.length - 1];
  if (!last) return "unservable-fold";
  if (needsFoldImport && !(await appendCoverageImport(store, lease, entries, scopeLabel))) {
    return "unservable-fold";
  }
  let firstMirror: TapeRecord | undefined;
  for (const entry of entries) {
    const mirror = await store.appendTape(lease, tapeEntryMirrorRecord(entry));
    firstMirror ??= mirror;
  }
  await store.appendTape(lease, {
    kind: "annotation",
    payload: tapeCheckpointPayload("turnEnd", undefined, 0),
    scopeLabel,
    entrySeq: last.seq,
    meta: { entryCreatedAt: last.createdAt },
  });
  await store.appendTape(lease, {
    kind: "context_event",
    payload: { event: RENDER_IMPORT_EVENT, firstTapeSeq: firstMirror!.seq },
    scopeLabel,
    coversEntrySeq: last.seq,
    meta: { entryCreatedAt: last.createdAt },
  });
  return "imported";
}

function entriesEqual(projected: readonly SessionEntry[], copied: readonly SessionEntry[]): boolean {
  if (projected.length !== copied.length) return false;
  return projected.every((entry, i) => {
    const other = copied[i]!;
    return (
      entry.seq === other.seq &&
      entry.parentSeq === other.parentSeq &&
      entry.type === other.type &&
      entry.scopeLabel === other.scopeLabel &&
      entry.createdAt === other.createdAt &&
      canonicalJson(entry.payload) === canonicalJson(other.payload)
    );
  });
}

function settledBound(row: TapeRecord): number | null {
  if (row.kind !== "annotation" || row.entrySeq === undefined) return null;
  const payload = row.payload as { turnEnd?: unknown; subturnEnd?: unknown; render?: unknown } | null;
  if (payload?.turnEnd !== true && payload?.subturnEnd !== true) return null;
  if (payload.render !== TAPE_RENDER_VERSION) return null;
  return row.entrySeq;
}

export function nativeForkTapeRows(
  forkSessionId: string,
  sourceRows: readonly TapeRecord[],
  copied: readonly SessionEntry[],
): NewTapeRecord[] | null {
  if (!copied.length) return null;
  const cut = copied[copied.length - 1]!.seq;
  let end = -1;
  sourceRows.forEach((row, i) => {
    const bound = settledBound(row);
    if (bound !== null && bound <= cut) end = i;
  });
  if (end < 0) return null;
  const candidate = sourceRows.slice(0, end + 1);
  const projection = projectTapeEntries(forkSessionId, candidate);
  if (!projection || !entriesEqual(projection.entries, copied)) return null;
  return candidate.map((row) => {
    const { sessionId: _sessionId, seq: _seq, createdAt: _createdAt, ...rec } = row;
    if (row.kind === "context_event" && (row.payload as { event?: unknown } | null)?.event === RENDER_IMPORT_EVENT) {
      const firstTapeSeq = (row.payload as { firstTapeSeq?: unknown }).firstTapeSeq;
      if (typeof firstTapeSeq === "number") {
        const remapped = candidate.findIndex((r) => r.seq >= firstTapeSeq);
        return { ...rec, payload: { ...(row.payload as Record<string, unknown>), firstTapeSeq: remapped } };
      }
    }
    return rec;
  });
}

export async function appendEntryOutsideTurn(
  sessions: TranscriptAppendSessions,
  lease: Lease,
  entry: NewEntry,
  modelText?: (appended: SessionEntry) => string,
): Promise<SessionEntry> {
  const view = await projectedSessionHistory(sessions, lease.sessionId);
  const allocate = createEntryAllocator(lease.sessionId, Math.max(view.latestSeq, view.entries.at(-1)?.seq ?? -1));
  const appended = allocate(entry);
  await sessions.appendTape(lease, {
    kind: "annotation",
    payload: tapeCheckpointPayload("turnEnd", { type: entry.type, payload: entry.payload, at: appended.createdAt }),
    scopeLabel: entry.scopeLabel,
    entrySeq: appended.seq,
    meta: { entryCreatedAt: appended.createdAt },
  });
  if (modelText) {
    await sessions.appendTape(lease, {
      kind: "message",
      payload: { role: "user", content: [{ type: "text", text: modelText(appended) }], timestamp: appended.createdAt },
      scopeLabel: entry.scopeLabel,
      meta: { entryCreatedAt: appended.createdAt },
    });
  }
  return appended;
}
