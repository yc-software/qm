import emojiData from "emoji-datasource/emoji.json" with { type: "json" };

const VS16 = /️/g;

function unifiedToChar(unified: string): string {
  return String.fromCodePoint(...unified.split("-").map((h) => parseInt(h, 16)));
}

const sortedEmojiData = [...emojiData].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

function buildMap(): Record<string, string> {
  const map = new Map<string, string>();
  const add = (raw: string | null | undefined, name: string): void => {
    if (!raw) return;
    const key = unifiedToChar(raw).replace(VS16, "");
    if (key && !map.has(key)) map.set(key, name);
  };
  for (const e of sortedEmojiData) {
    add(e.unified, e.short_name);
    add(e.non_qualified, e.short_name);
  }
  return Object.fromEntries(map);
}

export const EMOJI_NAME_BY_CHAR: Record<string, string> = buildMap();

export const EMOJI_CHAR_BY_NAME: Record<string, string> = {};
for (const [char, name] of Object.entries(EMOJI_NAME_BY_CHAR))
  if (!(name in EMOJI_CHAR_BY_NAME)) EMOJI_CHAR_BY_NAME[name] = char;

function buildQualifiedByName(): Record<string, string> {
  const map = new Map<string, string>();
  for (const e of sortedEmojiData) {
    for (const name of e.short_names) if (!map.has(name)) map.set(name, unifiedToChar(e.unified));
  }
  return Object.fromEntries(map);
}

export const EMOJI_QUALIFIED_BY_NAME: Record<string, string> = buildQualifiedByName();

const SKIN_TONE_BY_MODIFIER: Record<string, string> = {
  "🏻": "2",
  "🏼": "3",
  "🏽": "4",
  "🏾": "5",
  "🏿": "6",
};
const SKIN_TONE_MODIFIER = /[\u{1F3FB}-\u{1F3FF}]/gu;

export function emojiNameOf(s: string): string | null {
  let tone: string | undefined;
  const base = s
    .replace(SKIN_TONE_MODIFIER, (m) => {
      tone = SKIN_TONE_BY_MODIFIER[m];
      return "";
    })
    .replace(VS16, "");
  const name = EMOJI_NAME_BY_CHAR[base];
  if (!name) return null;
  return tone ? `${name}::skin-tone-${tone}` : name;
}
