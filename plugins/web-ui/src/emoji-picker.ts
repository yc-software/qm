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
