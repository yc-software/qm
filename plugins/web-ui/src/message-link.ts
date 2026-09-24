import type { TranscriptPage } from "./core-bridge.ts";

export function messageLinkSeq(search: string): number | null {
  const value = new URLSearchParams(search).get("seq");
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const seq = Number(value);
  return Number.isSafeInteger(seq) ? seq : null;
}

export async function loadMessageTranscript(
  load: (window: { tailTurns: number; beforeSeq?: number }) => Promise<TranscriptPage>,
  seq: number | null,
  tailTurns: number,
): Promise<TranscriptPage> {
  let page = await load({ tailTurns });
  let first = page.entries[0]?.seq;
  while (seq !== null && first !== undefined && seq < first && (page.earlierEntries ?? 0) > 0) {
    const older = await load({ tailTurns: Math.max(tailTurns, 40), beforeSeq: first });
    const next = older.entries[0]?.seq;
    if (next === undefined || next >= first) break;
    const entries = new Map([...older.entries, ...page.entries].map((entry) => [entry.seq, entry]));
    page = { ...page, entries: [...entries.values()], earlierEntries: older.earlierEntries ?? 0 };
    first = next;
  }
  return page;
}

export function messageEntrySeqs(message: unknown): number[] {
  const value = message as { entrySeq?: number; entrySeqs?: number[]; work?: { activity?: Array<{ seq: number }> } };
  return [
    ...new Set([
      ...(value.entrySeq !== undefined ? [value.entrySeq] : []),
      ...(value.entrySeqs ?? []),
      ...(value.work?.activity ?? []).map((entry) => entry.seq),
    ]),
  ];
}

export function highlightMessage(host: HTMLElement, seq: number): boolean {
  if (!Number.isSafeInteger(seq) || seq < 0) return false;
  const row = host.querySelector<HTMLElement>(`.message-row[data-entry-seqs~="${seq}"]`);
  if (!row) return false;
  for (const old of host.querySelectorAll(".linked-message")) old.classList.remove("linked-message");
  row.classList.add("linked-message");
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "center", behavior: "instant" });
  return true;
}
