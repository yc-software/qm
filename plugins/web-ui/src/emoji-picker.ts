import { EMOJI_ROWS, type EmojiRow } from "./emoji-data.ts";

export type { EmojiRow };

function normalizeName(name: string): string {
  return name.toLowerCase().replaceAll("-", "_");
}

const names = new Map<string, EmojiRow>();
for (const row of EMOJI_ROWS) {
  for (const name of [row.n, ...(row.a ?? [])]) {
    const normalized = normalizeName(name);
    if (!names.has(normalized)) names.set(normalized, row);
  }
}

export function rowForName(name: string): EmojiRow | null {
  return names.get(normalizeName(name)) ?? null;
}

export function matchesQuery(row: EmojiRow, needle: string): boolean {
  if (!needle) return true;
  if (normalizeName(row.n).includes(normalizeName(needle))) return true;
  return (row.a ?? []).some((alias) => normalizeName(alias).includes(normalizeName(needle)));
}

export function filterEmoji(rows: readonly EmojiRow[], query: string): EmojiRow[] {
  const needle = query.trim().toLowerCase().replace(/^:+/, "").replace(/:+$/, "");
  if (!needle) return [...rows];
  return rows.filter((row) => matchesQuery(row, needle));
}

export function groupEmoji(
  rows: readonly EmojiRow[],
  order: readonly string[],
): Array<{ group: string; rows: EmojiRow[] }> {
  const byGroup = new Map<string, EmojiRow[]>();
  for (const row of rows) {
    const bucket = byGroup.get(row.g);
    if (bucket) bucket.push(row);
    else byGroup.set(row.g, [row]);
  }
  return order.filter((g) => byGroup.has(g)).map((group) => ({ group, rows: byGroup.get(group)! }));
}

export function charForName(name: string): string | null {
  return rowForName(name)?.c ?? null;
}
