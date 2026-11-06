import { isUserItem, type Item } from "../sessions/items.ts";

export function retainedSnapshot<T extends { anchorSeq?: number; sessionId?: string }>(
  history: readonly Item[],
  read: (item: Item) => T | undefined,
): { previous?: T; anchorSeq?: number } {
  const entry = history.findLast((entry) => isUserItem(entry) && read(entry));
  const previous = entry && read(entry);
  if (!entry || !previous || (previous.sessionId !== undefined && previous.sessionId !== entry.sessionId)) return {};
  const anchorSeq = previous.anchorSeq ?? entry.seq;
  const anchor = history.find((candidate) => candidate.seq === anchorSeq && isUserItem(candidate));
  const baseline = anchor && read(anchor);
  if (!baseline || baseline.anchorSeq !== undefined) return {};
  return { previous, anchorSeq };
}
