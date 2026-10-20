interface EmojiSourceRow {
  unified: string;
  short_names: string[];
  category: string;
  sort_order: number;
}

export function emojiTable(source: readonly EmojiSourceRow[]): string[][] {
  return source
    .filter((e) => e.category !== "Component")
    .toSorted((x, y) => x.sort_order - y.sort_order)
    .map((e) => [e.unified, ...e.short_names]);
}

export function emojiTableModule(source: readonly EmojiSourceRow[]): string {
  return `export const EMOJI_TABLE = ${JSON.stringify(emojiTable(source))};`;
}
