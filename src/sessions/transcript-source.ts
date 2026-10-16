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

export function transcriptEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  const received = new Set(
    entries.flatMap((entry) => {
      const payload = entry.payload as { ts?: string; slackReplyReceipt?: boolean } | null;
      return entry.type === "user" && payload?.ts && !payload.slackReplyReceipt ? [payload.ts] : [];
    }),
  );
  return entries.filter((entry) => {
    const payload = entry.payload as { ts?: string; slackReplyReceipt?: boolean } | null;
    return entry.type !== "soul" && !(payload?.slackReplyReceipt && payload.ts && received.has(payload.ts));
  });
}

const emptyWindowStart = (opts?: GetEntriesOptions): number =>
  Math.min(opts?.sinceSeq ?? Infinity, opts?.beforeSeq ?? Infinity, Number.MAX_SAFE_INTEGER);

export function createTranscriptSource(sessions: TranscriptStore): TranscriptSource {
  const read = async (
    sessionId: string,
    opts: GetEntriesOptions | undefined,
    principalId?: string,
  ): Promise<TranscriptRead> => {
    const entries = transcriptEntries(
      principalId === undefined
        ? await sessions.getEntries(sessionId, { ...opts, transcript: true })
        : await sessions.visibleEntries(sessionId, principalId, { ...opts, transcript: true }),
    );
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
