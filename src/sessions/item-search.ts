import { isUserMessage, type Item } from "./items.ts";

export const SEARCH_HIT_LIMIT = 40;

export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const MIN_PREFIX_LEN = 3;

export function tsPrefixQuery(query: string): string | null {
  const terms = searchTerms(query);
  if (!terms.length) return null;
  return terms.map((t) => (t.length >= MIN_PREFIX_LEN ? `${t}:*` : t)).join(" & ");
}

export function searchAuthor(item: Pick<Item, "kind" | "body">): string | undefined {
  if (!isUserMessage(item)) return undefined;
  const name = item.body.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

export function matchesSearchTerms(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return false;
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return terms.every((term) => words.some((w) => (term.length >= MIN_PREFIX_LEN ? w.startsWith(term) : w === term)));
}

function wordPrefixIndex(lower: string, term: string): number {
  for (let i = lower.indexOf(term); i >= 0; i = lower.indexOf(term, i + 1)) {
    if (i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1]!)) return i;
  }
  return -1;
}

export function searchSnippet(text: string, terms: readonly string[], max = 240): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const lower = oneLine.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = wordPrefixIndex(lower, t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) at = 0;
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), oneLine.length - max));
  const clip = oneLine.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${clip}${start + max < oneLine.length ? "…" : ""}`;
}
