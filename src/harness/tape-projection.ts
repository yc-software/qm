import type { SessionEntry } from "../types.ts";
import type { GetEntriesOptions, NewSearchEntry, SessionStore } from "../sessions/session-store.ts";
import { entryWithinTenure } from "../sessions/session-store.ts";
import { entrySearchAuthor, entrySearchText, SEARCHABLE_ENTRY_TYPES } from "../sessions/entry-search.ts";

type TranscriptStore = Pick<SessionStore, "getEntries" | "countEntries" | "visibleEntries" | "participantWindowsOf">;

interface TranscriptRead {
  entries: SessionEntry[];
  earlier: number;
}

export interface TranscriptSource {
  forRender(sessionId: string, opts?: GetEntriesOptions): Promise<TranscriptRead>;
  forViewer(
    sessionId: string,
    principalId: string,
    opts?: { limit?: number; beforeSeq?: number },
  ): Promise<TranscriptRead>;
}

export function createTranscriptSource(sessions: TranscriptStore): TranscriptSource {
  return {
    async forRender(sessionId, opts?) {
      const entries = await sessions.getEntries(sessionId, opts);
      return {
        entries,
        earlier: entries.length ? await sessions.countEntries(sessionId, { beforeSeq: entries[0]!.seq }) : 0,
      };
    },
    async forViewer(sessionId, principalId, opts?) {
      const windows = await sessions.participantWindowsOf(sessionId);
      const window = windows.find((item) => item.principalId === principalId);
      if (!window || opts?.limit === 0) return { entries: [], earlier: 0 };
      if (window.validFromSeq === null || window.validTo !== null) {
        const visible = (await sessions.visibleEntries(sessionId, principalId)).filter(
          (entry) => opts?.beforeSeq === undefined || entry.seq < opts.beforeSeq,
        );
        const entries = opts?.limit === undefined ? visible : visible.slice(-opts.limit);
        return { entries, earlier: visible.length - entries.length };
      }
      const entries = (
        await sessions.getEntries(sessionId, {
          sinceSeq: window.validFromSeq,
          beforeSeq: opts?.beforeSeq,
          ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
        })
      ).filter((entry) => entryWithinTenure(entry, window));
      return {
        entries,
        earlier: entries.length
          ? await sessions.countEntries(sessionId, { sinceSeq: window.validFromSeq, beforeSeq: entries[0]!.seq })
          : 0,
      };
    },
  };
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
