import emojiData from "emoji-datasource/emoji.json" with { type: "json" };

const VS16 = /️/g;

function unifiedToChar(unified: string): string {
  return String.fromCodePoint(...unified.split("-").map((h) => parseInt(h, 16)));
}

function buildMap(): Record<string, string> {
  const data = [...emojiData].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const map = new Map<string, string>();
  const add = (raw: string | null | undefined, name: string): void => {
    if (!raw) return;
    const key = unifiedToChar(raw).replace(VS16, "");
    if (key && !map.has(key)) map.set(key, name);
  };
  for (const e of data) {
    add(e.unified, e.short_name);
    add(e.non_qualified, e.short_name);
  }
  return Object.fromEntries(map);
}

export const EMOJI_NAME_BY_CHAR: Record<string, string> = buildMap();
