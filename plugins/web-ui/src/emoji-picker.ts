import { EMOJI_TABLE } from "./emoji-table.ts";

export interface EmojiRow {
  n: string;
  c: string;
  a: string[];
}

export const EMOJI_ROWS: readonly EmojiRow[] = EMOJI_TABLE.map(([unified, n, ...a]) => ({
  n: n!,
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

export function charForName(name: string): string | null {
  return rowForName(name)?.c ?? null;
}
