import { EMOJI_TABLE } from "./emoji-table.ts";

export interface EmojiRow {
  n: string;
  c: string;
  a: string[];
  g: string;
}

export const EMOJI_ROWS: readonly EmojiRow[] = EMOJI_TABLE.map(([unified, g, n, ...a]) => ({
  n: n!,
  g: g!,
  c: String.fromCodePoint(...unified!.split("-").map((hex) => parseInt(hex, 16))),
  a,
}));

function normalizeName(name: string): string {
  return name.toLowerCase().replaceAll("-", "_");
}

const names = new Map<string, EmojiRow>();
for (const row of EMOJI_ROWS) {
  for (const name of [row.n, ...row.a]) {
    const normalized = normalizeName(name);
    if (!names.has(normalized)) names.set(normalized, row);
  }
}

export function rowForName(name: string): EmojiRow | null {
  return names.get(normalizeName(name)) ?? null;
}

function matchesQuery(row: EmojiRow, needle: string): boolean {
  return [row.n, ...row.a].some((name) => normalizeName(name).includes(normalizeName(needle)));
}

export function filterEmoji(rows: readonly EmojiRow[], query: string): EmojiRow[] {
  const needle = query.trim().toLowerCase().replace(/^:+/, "").replace(/:+$/, "");
  if (!needle) return [...rows];
  return rows.filter((row) => matchesQuery(row, needle));
}

const searchIndex = EMOJI_ROWS.map((row) => ({ row, terms: [row.n, ...row.a].map(normalizeName) }));
const searchCache = new Map<string, EmojiRow[]>();

export function emojiMatches(query: string, limit: number): EmojiRow[] {
  const key = normalizeName(query);
  const cached = searchCache.get(key);
  if (cached) return cached;
  const exact = rowForName(key);
  const found = exact ? [exact] : [];
  for (const { row, terms } of searchIndex) {
    if (found.length === limit) break;
    if (row !== exact && terms.some((term) => term.includes(key))) found.push(row);
  }
  if (searchCache.size >= 256) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(key, found);
  return found;
}

export function charForName(name: string): string | null {
  return rowForName(name)?.c ?? null;
}
