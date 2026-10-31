import { isObj } from "../util/objects.ts";
import type { SessionEntry } from "../types.ts";
import { contextSummaryPayload, isOverheardEntry } from "./session-store.ts";
import { entrySearchAuthor } from "./entry-search.ts";
import { headSlice, tailSlice } from "../util/text.ts";

const MAX_HIT_CHARS = 500;
const MATCH_LEAD_CHARS = 100;

function clipHit(text: string, terms: string[]): string {
  if (text.length <= MAX_HIT_CHARS) return text;
  const lower = text.toLowerCase();
  const positions = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  if (first + MATCH_LEAD_CHARS <= MAX_HIT_CHARS) return `${text.slice(0, MAX_HIT_CHARS)}…`;
  const start = first - MATCH_LEAD_CHARS;
  const end = start + MAX_HIT_CHARS;
  return `…${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function entryText(entry: SessionEntry): string {
  const summary = contextSummaryPayload(entry);
  if (summary) return summary.text;
  const text = (entry.payload as { text?: string } | null)?.text;
  if (typeof text === "string" && text.trim()) return text;
  if (!isObj(entry.payload)) return JSON.stringify(entry.payload ?? {});
  const { step: _step, wire: _wire, ...rest } = entry.payload as Record<string, unknown>;
  return JSON.stringify(rest);
}

const MAX_OPEN_CHARS = 20_000;
const OPEN_TAIL_CHARS = 2_000;

function entryLabel(entry: SessionEntry): string {
  const stamp = `(${new Date(entry.createdAt).toISOString()})`;
  if (isOverheardEntry(entry)) {
    const author = entrySearchAuthor(entry) ?? "someone";
    return `overheard#${entry.seq} ${stamp} ${author} (untrusted, SAID — not established fact):`;
  }
  const author = entrySearchAuthor(entry);
  return `${entry.type}#${entry.seq} ${stamp}${author ? ` ${author}:` : ":"}`;
}

export function openSessionEntry(entries: SessionEntry[], seq: number): string | null {
  const entry = entries.find((e) => e.seq === seq);
  if (!entry) return null;
  const text = entryText(entry).trim();
  const body =
    text.length <= MAX_OPEN_CHARS
      ? text
      : `${headSlice(text, MAX_OPEN_CHARS - OPEN_TAIL_CHARS)}\n… [${text.length} chars total; middle elided] …\n${tailSlice(text, OPEN_TAIL_CHARS)}`;
  return `${entryLabel(entry)} ${body}`;
}

export function searchSessionEntries(entries: SessionEntry[], query: string, limit = 20): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: string[] = [];
  for (let i = entries.length - 1; i >= 0 && hits.length < limit; i--) {
    const entry = entries[i]!;
    const text = entryText(entry).trim();
    const author = entrySearchAuthor(entry);
    const haystack = `${author ? `${author} ` : ""}${text}`.toLowerCase();
    if (!terms.every((t) => haystack.includes(t))) continue;
    const clipped = clipHit(text, terms);
    hits.push(`${entryLabel(entry)} ${clipped}`);
  }
  return hits;
}
