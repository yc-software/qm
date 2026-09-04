import type { SessionEntry } from "../types.ts";
import { contextSummaryPayload } from "../harness/context-compaction.ts";

const MAX_HIT_CHARS = 500;

function entryText(entry: SessionEntry): string {
  const summary = contextSummaryPayload(entry);
  if (summary) return summary.text;
  const text = (entry.payload as { text?: string } | null)?.text;
  if (typeof text === "string" && text.trim()) return text;
  return JSON.stringify(entry.payload ?? {});
}

function entryAuthor(entry: SessionEntry): string | undefined {
  if (entry.type !== "user") return undefined;
  const name = (entry.payload as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

export function searchSessionEntries(entries: SessionEntry[], query: string, limit = 20): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: string[] = [];
  for (let i = entries.length - 1; i >= 0 && hits.length < limit; i--) {
    const entry = entries[i]!;
    const text = entryText(entry).trim();
    const author = entryAuthor(entry);
    const haystack = `${author ? `${author} ` : ""}${text}`.toLowerCase();
    if (!terms.every((t) => haystack.includes(t))) continue;
    const clipped = text.length > MAX_HIT_CHARS ? `${text.slice(0, MAX_HIT_CHARS)}…` : text;
    const who = author ? ` ${author}:` : ":";
    hits.push(`${entry.type}#${entry.seq} (${new Date(entry.createdAt).toISOString()})${who} ${clipped}`);
  }
  return hits;
}
