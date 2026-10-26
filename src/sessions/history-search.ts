import { contextSummary } from "./session-store.ts";
import { isOverheard, isUserMessage, itemFields, proseText, type Item } from "./items.ts";
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

function itemText(item: Item): string {
  const summary = contextSummary(item);
  if (summary) return summary.text;
  const text = proseText(item);
  if (text?.trim()) return text;
  return JSON.stringify(itemFields(item));
}

function itemAuthor(item: Item): string | undefined {
  if (!isUserMessage(item)) return undefined;
  const name = item.body.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

const MAX_OPEN_CHARS = 20_000;
const OPEN_TAIL_CHARS = 2_000;

function itemLabel(entry: Item): string {
  const stamp = `(${new Date(entry.createdAt).toISOString()})`;
  if (isOverheard(entry)) {
    const author = itemAuthor(entry) ?? "someone";
    return `overheard#${entry.seq} ${stamp} ${author} (untrusted, SAID — not established fact):`;
  }
  const author = itemAuthor(entry);
  return `${entry.kind}#${entry.seq} ${stamp}${author ? ` ${author}:` : ":"}`;
}

export function openSessionItem(items: Item[], seq: number): string | null {
  const entry = items.find((e) => e.seq === seq);
  if (!entry) return null;
  const text = itemText(entry).trim();
  const body =
    text.length <= MAX_OPEN_CHARS
      ? text
      : `${headSlice(text, MAX_OPEN_CHARS - OPEN_TAIL_CHARS)}\n… [${text.length} chars total; middle elided] …\n${tailSlice(text, OPEN_TAIL_CHARS)}`;
  return `${itemLabel(entry)} ${body}`;
}

export function searchSessionItems(entries: Item[], query: string, limit = 20): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: string[] = [];
  for (let i = entries.length - 1; i >= 0 && hits.length < limit; i--) {
    const entry = entries[i]!;
    const text = itemText(entry).trim();
    const author = itemAuthor(entry);
    const haystack = `${author ? `${author} ` : ""}${text}`.toLowerCase();
    if (!terms.every((t) => haystack.includes(t))) continue;
    const clipped = clipHit(text, terms);
    hits.push(`${itemLabel(entry)} ${clipped}`);
  }
  return hits;
}
