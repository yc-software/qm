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

function needleOf(query: string): string {
  return normalizeName(query.trim().replace(/^:+/, "").replace(/:+$/, ""));
}

function matchesNeedle(row: EmojiRow, needle: string): boolean {
  return [row.n, ...row.a].some((name) => normalizeName(name).includes(needle));
}

export function filterEmoji(rows: readonly EmojiRow[], query: string): EmojiRow[] {
  const needle = needleOf(query);
  return needle ? rows.filter((row) => matchesNeedle(row, needle)) : [...rows];
}

export function emojiMatches(query: string, limit: number): EmojiRow[] {
  const exact = rowForName(needleOf(query));
  const rest = filterEmoji(EMOJI_ROWS, query).filter((row) => row !== exact);
  return (exact ? [exact, ...rest] : rest).slice(0, limit);
}

export function charForName(name: string): string | null {
  return rowForName(name)?.c ?? null;
}
