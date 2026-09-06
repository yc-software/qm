import type { EmojiRow } from "./emoji-data";

export type { EmojiRow };

export function matchesQuery(row: EmojiRow, needle: string): boolean {
  if (!needle) return true;
  if (row.n.includes(needle)) return true;
  return (row.a ?? []).some((alias) => alias.includes(needle));
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

let nameToChar: Map<string, string> | null = null;

export function charForName(name: string): string | null {
  return nameToChar?.get(name) ?? null;
}

export function ensureEmojiIndex(): Promise<void> {
  if (nameToChar) return Promise.resolve();
  return import("./emoji-data").then(({ EMOJI_ROWS }) => {
    if (nameToChar) return;
    const index = new Map<string, string>();
    for (const row of EMOJI_ROWS) {
      if (!index.has(row.n)) index.set(row.n, row.c);
      for (const alias of row.a ?? []) if (!index.has(alias)) index.set(alias, row.c);
    }
    nameToChar = index;
  });
}
