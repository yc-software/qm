import type { SessionEntry } from "../types.ts";
import type { GetEntriesOptions, SessionStore } from "./session-store.ts";

type TranscriptStore = Pick<SessionStore, "getEntries" | "visibleEntries" | "countEntriesBefore">;

interface TranscriptRead {
  entries: SessionEntry[];
  earlier: number;
}

export interface TranscriptSource {
  forRender(sessionId: string, opts?: GetEntriesOptions): Promise<TranscriptRead>;
  forViewer(sessionId: string, principalId: string, opts?: GetEntriesOptions): Promise<TranscriptRead>;
}

export function commonEntrySeqs(views: readonly (readonly SessionEntry[])[]): Set<number> {
  const common = new Set((views[0] ?? []).map((entry) => entry.seq));
  for (const view of views.slice(1)) {
    const visible = new Set(view.map((entry) => entry.seq));
    for (const seq of common) if (!visible.has(seq)) common.delete(seq);
  }
  return common;
}

const emptyWindowStart = (opts?: GetEntriesOptions): number =>
  Math.min(opts?.sinceSeq ?? Infinity, opts?.beforeSeq ?? Infinity, Number.MAX_SAFE_INTEGER);

export function createTranscriptSource(sessions: TranscriptStore): TranscriptSource {
  const read = async (
    sessionId: string,
    opts: GetEntriesOptions | undefined,
    principalId?: string,
  ): Promise<TranscriptRead> => {
    const entries =
      principalId === undefined
        ? await sessions.getEntries(sessionId, { ...opts, transcript: true })
        : await sessions.visibleEntries(sessionId, principalId, { ...opts, transcript: true });
    const windowed = opts?.sinceSeq !== undefined || (opts?.limit !== undefined && entries.length >= opts.limit);
    const earlier = windowed
      ? await sessions.countEntriesBefore(sessionId, entries[0]?.seq ?? emptyWindowStart(opts), principalId)
      : 0;
    return { entries, earlier };
  };
  return {
    forRender: (sessionId, opts) => read(sessionId, opts),
    forViewer: (sessionId, principalId, opts) => read(sessionId, opts, principalId),
  };
}
