/**
 * Cut points that never split what a reader (or Slack's parser) treats as one
 * unit: a surrogate pair (emoji), a `<url|label>` entity, or an inline code /
 * bold / strike span. Backing off never goes past `floor` characters (a
 * pathological single entity longer than the whole budget is cut anyway —
 * better a broken link than an empty message).
 */
const FLOOR_FRACTION = 0.25;

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The largest index <= max that is safe to cut at. */
export function safeCutIndex(text: string, max: number): number {
  if (text.length <= max) return text.length;
  let cut = max;
  // never split a surrogate pair
  if (isLowSurrogate(text.charCodeAt(cut))) cut--;
  const floor = Math.max(1, Math.floor(max * FLOOR_FRACTION));
  // never split a <...> entity (links, mentions): back off to before the "<"
  const lastOpen = text.lastIndexOf("<", cut - 1);
  if (lastOpen >= 0) {
    const lastClose = text.lastIndexOf(">", cut - 1);
    if (lastOpen > lastClose && lastOpen >= floor) cut = lastOpen;
  }
  // never leave an unbalanced formatting run open right at the cut
  for (const marker of ["`", "*", "~"]) {
    let count = 0;
    for (let i = 0; i < cut; i++) if (text[i] === marker) count++;
    if (count % 2 === 1) {
      const back = text.lastIndexOf(marker, cut - 1);
      if (back >= floor) cut = Math.min(cut, back);
    }
  }
  if (isLowSurrogate(text.charCodeAt(cut))) cut--;
  return Math.max(cut, 1);
}

/** Split text into chunks of at most `max`, cutting only at safe points. */
export function safeChunks(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const cut = safeCutIndex(rest, max);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return chunks.length ? chunks : [""];
}

/** Truncate to at most `max` characters (plus ellipsis) at a safe point. */
export function safeClip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, safeCutIndex(text, max))}…`;
}
