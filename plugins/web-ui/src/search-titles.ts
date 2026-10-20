import type { CoreSession } from "./core-bridge";

function words(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Sessions whose title (or channel name) has a word starting with every query
 * term — the same word-prefix feel as message search, but instant and local.
 * Live chats before archived ones, most recently active first. */
export function matchSessionTitles(
  sessions: readonly CoreSession[],
  query: string,
  title: (session: CoreSession) => string,
  limit: number,
): CoreSession[] {
  const terms = words(query);
  if (!terms.length) return [];
  const when = (s: CoreSession): number => s.lastActivityAt ?? s.createdAt;
  return sessions
    .filter((s) => !s.parentSessionId)
    .filter((s) => {
      const haystack = words(`${title(s)} ${s.channelName ?? ""}`);
      return terms.every((term) => haystack.some((word) => word.startsWith(term)));
    })
    .sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)) || when(b) - when(a))
    .slice(0, limit);
}
