import type { TranscriptPage } from "./core-bridge.ts";
import { activitySeq, type WorkActivity } from "./items.ts";

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
  let first = page.items[0]?.seq;
  while (seq !== null && first !== undefined && seq < first && (page.earlierItems ?? 0) > 0) {
    const older = await load({ tailTurns: Math.max(tailTurns, 40), beforeSeq: first });
    const next = older.items[0]?.seq;
    if (next === undefined || next >= first) break;
    const items = new Map([...older.items, ...page.items].map((item) => [item.seq, item]));
    page = { ...page, items: [...items.values()], earlierItems: older.earlierItems ?? 0 };
    first = next;
  }
  return page;
}

export function messageEntrySeqs(message: unknown): number[] {
  const value = message as { entrySeq?: number; entrySeqs?: number[]; work?: { activity?: WorkActivity[] } };
  return [
    ...new Set([
      ...(value.entrySeq !== undefined ? [value.entrySeq] : []),
      ...(value.entrySeqs ?? []),
      ...(value.work?.activity ?? []).map(activitySeq),
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
