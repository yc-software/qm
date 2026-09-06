const FLOOR_FRACTION = 0.25;

const FENCE = "```";
const FENCE_CLOSE = "\n```";
const FENCE_REOPEN = "```\n";
const MIN_FENCE_SPLIT_BUDGET = 32;

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

function countFenceTokens(text: string): number {
  let count = 0;
  for (let i = 0; (i = text.indexOf(FENCE, i)) >= 0; i += FENCE.length) count++;
  return count;
}

function fenceCutIndex(text: string, max: number): number {
  let cut = max;
  if (isLowSurrogate(text.charCodeAt(cut))) cut--;
  const floor = Math.max(1, Math.floor(max * FLOOR_FRACTION));
  while (cut > floor && text[cut] === "`" && text[cut - 1] === "`") cut--;
  const lineStart = text.lastIndexOf("\n", cut - 1) + 1;
  if (lineStart >= floor) cut = lineStart;
  return Math.max(cut, 1);
}

export function safeChunks(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  let inFence = false;
  for (;;) {
    const prefix = inFence ? FENCE_REOPEN : "";
    if (prefix.length + rest.length <= max) {
      chunks.push(prefix + rest);
      break;
    }
    const fenceMachineryFits = max >= MIN_FENCE_SPLIT_BUDGET;
    if (!fenceMachineryFits || (!inFence && !rest.slice(0, max + FENCE.length).includes(FENCE))) {
      const cut = safeCutIndex(rest, max);
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
      continue;
    }
    const budget = Math.max(1, max - prefix.length - FENCE_CLOSE.length);
    const cut = fenceCutIndex(rest, budget);
    const openAtCut: boolean = inFence !== (countFenceTokens(rest.slice(0, cut)) % 2 === 1);
    let piece = rest.slice(0, cut);
    if (openAtCut) piece = piece.replace(/\n$/, "") + FENCE_CLOSE;
    chunks.push(prefix + piece);
    rest = rest.slice(cut);
    inFence = openAtCut;
  }
  return chunks;
}

/** Truncate to at most `max` characters (plus ellipsis) at a safe point. */
export function safeClip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, safeCutIndex(text, max))}…`;
}
