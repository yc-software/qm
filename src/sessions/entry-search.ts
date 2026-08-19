import type { SessionEntry } from "../types.ts";

export const SEARCH_HIT_LIMIT = 40;
const MAX_TERMS = 8;

/** Lowercased alphanumeric terms, in query order — the shared tokenizer for both stores. */
export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_TERMS);
}

/** Terms shorter than this match whole words only — 1-2 char prefixes expand to
 * enormous GIN key sets and dominate search latency. */
const MIN_PREFIX_LEN = 3;

/** A `to_tsquery('simple', …)` expression: every term required; terms long
 * enough to be selective prefix-match (last-token-friendly), shorter ones
 * match exactly. */
export function tsPrefixQuery(query: string): string | null {
  const terms = searchTerms(query);
  if (!terms.length) return null;
  return terms.map((t) => (t.length >= MIN_PREFIX_LEN ? `${t}:*` : t)).join(" & ");
}

/** The searchable text of an entry payload — mirrors the Postgres `entry_search_text` function. */
export function entrySearchText(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  const text = (payload as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : null;
}

export function entrySearchAuthor(entry: Pick<SessionEntry, "type" | "payload">): string | undefined {
  if (entry.type !== "user") return undefined;
  const name = (entry.payload as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/** In-memory mirror of the tsquery semantics: every term matches some word —
 * by prefix when long enough, exactly otherwise. */
export function matchesSearchTerms(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return false;
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return terms.every((term) => words.some((w) => (term.length >= MIN_PREFIX_LEN ? w.startsWith(term) : w === term)));
}

/** First occurrence of `term` in `lower` that starts at a word boundary —
 * matching the word-prefix semantics of the search itself, so the snippet
 * window centers on the text that actually caused the hit. */
function wordPrefixIndex(lower: string, term: string): number {
  for (let i = lower.indexOf(term); i >= 0; i = lower.indexOf(term, i + 1)) {
    if (i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1]!)) return i;
  }
  return -1;
}

/** One-line snippet centered on the first matching term. */
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
