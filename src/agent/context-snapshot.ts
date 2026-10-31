import type { SessionEntry } from "../types.ts";

export function retainedSnapshot<T extends { anchorSeq?: number; sessionId?: string }>(
  history: readonly SessionEntry[],
  read: (entry: SessionEntry) => T | undefined,
): { previous?: T; anchorSeq?: number } {
  const entry = history.findLast((entry) => entry.type === "user" && read(entry));
  const previous = entry && read(entry);
  if (!entry || !previous || (previous.sessionId !== undefined && previous.sessionId !== entry.sessionId)) return {};
  const anchorSeq = previous.anchorSeq ?? entry.seq;
  const anchor = history.find((candidate) => candidate.seq === anchorSeq && candidate.type === "user");
  const baseline = anchor && read(anchor);
  if (!baseline || baseline.anchorSeq !== undefined) return {};
  return { previous, anchorSeq };
}
