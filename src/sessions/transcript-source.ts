import type { Item } from "./items.ts";
import type { GetItemsOptions, SessionStore } from "./session-store.ts";

type TranscriptStore = Pick<SessionStore, "getItems" | "visibleItems" | "countItemsBefore">;

interface TranscriptRead {
  items: Item[];
  earlier: number;
}

export interface TranscriptSource {
  forRender(sessionId: string, opts?: GetItemsOptions): Promise<TranscriptRead>;
  forViewer(sessionId: string, principalId: string, opts?: GetItemsOptions): Promise<TranscriptRead>;
}

export function transcriptItems(items: readonly Item[]): Item[] {
  const receipt = (item: Item): boolean => item.kind === "UserMessage" && item.body.slackReplyReceipt === true;
  const received = new Set(
    items.flatMap((item) =>
      item.kind === "UserMessage" && item.externalId && !receipt(item) ? [item.externalId] : [],
    ),
  );
  return items.filter((item) => !(receipt(item) && item.externalId && received.has(item.externalId)));
}

const emptyWindowStart = (opts?: GetItemsOptions): number =>
  Math.min(opts?.sinceSeq ?? Infinity, opts?.beforeSeq ?? Infinity, Number.MAX_SAFE_INTEGER);

export function createTranscriptSource(sessions: TranscriptStore): TranscriptSource {
  const read = async (
    sessionId: string,
    opts: GetItemsOptions | undefined,
    principalId?: string,
  ): Promise<TranscriptRead> => {
    const items =
      principalId === undefined
        ? await sessions.getItems(sessionId, { ...opts, transcript: true })
        : await sessions.visibleItems(sessionId, principalId, { ...opts, transcript: true });
    const windowed = opts?.sinceSeq !== undefined || (opts?.limit !== undefined && items.length >= opts.limit);
    const earlier = windowed
      ? await sessions.countItemsBefore(sessionId, items[0]?.seq ?? emptyWindowStart(opts), principalId)
      : 0;
    return { items, earlier };
  };
  return {
    forRender: (sessionId, opts) => read(sessionId, opts),
    forViewer: (sessionId, principalId, opts) => read(sessionId, opts, principalId),
  };
}
