import { isOverheard, itemFields, type Item, proseText } from "./items.ts";
import { itemSearchAuthor } from "./entry-search.ts";
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
  const text = proseText(item);
  return text?.trim() ? text : JSON.stringify(itemFields(item));
}

const MAX_OPEN_CHARS = 20_000;
const OPEN_TAIL_CHARS = 2_000;

function itemLabel(item: Item): string {
  const stamp = `(${new Date(item.createdAt).toISOString()})`;
  if (isOverheard(item)) {
    const author = itemSearchAuthor(item) ?? "someone";
    return `overheard#${item.seq} ${stamp} ${author} (untrusted, SAID — not established fact):`;
  }
  const author = itemSearchAuthor(item);
  return `${item.kind}#${item.seq} ${stamp}${author ? ` ${author}:` : ":"}`;
}

export function openSessionItem(items: Item[], seq: number): string | null {
  const item = items.find((e) => e.seq === seq);
  if (!item) return null;
  const text = itemText(item).trim();
  const body =
    text.length <= MAX_OPEN_CHARS
      ? text
      : `${headSlice(text, MAX_OPEN_CHARS - OPEN_TAIL_CHARS)}\n… [${text.length} chars total; middle elided] …\n${tailSlice(text, OPEN_TAIL_CHARS)}`;
  return `${itemLabel(item)} ${body}`;
}

export function searchSessionItems(items: Item[], query: string, limit = 20): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: string[] = [];
  for (let i = items.length - 1; i >= 0 && hits.length < limit; i--) {
    const item = items[i]!;
    const text = itemText(item).trim();
    const author = itemSearchAuthor(item);
    const haystack = `${author ? `${author} ` : ""}${text}`.toLowerCase();
    if (!terms.every((t) => haystack.includes(t))) continue;
    const clipped = clipHit(text, terms);
    hits.push(`${itemLabel(item)} ${clipped}`);
  }
  return hits;
}
