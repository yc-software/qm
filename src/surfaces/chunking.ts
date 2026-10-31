const FLOOR_FRACTION = 0.25;
const MAX_REOPEN_FENCE_DIVISOR = 4;
const MIN_FENCE_SPLIT_BUDGET = 32;

const FENCE = "```";
const FENCE_CLOSE = "\n```";
const MARKERS = ["`", "*", "~"];

export interface ProtectedSpan {
  open: string;
  close: string;
}

type CutAt = (text: string, max: number) => number;

export interface ChunkOptions {
  cutAt: CutAt;
  keepFenceInfo?: boolean;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function safeCutIndex(text: string, max: number, span?: ProtectedSpan): number {
  if (text.length <= max) return text.length;
  let cut = max;
  if (isLowSurrogate(text.charCodeAt(cut))) cut--;
  const floor = Math.max(1, Math.floor(max * FLOOR_FRACTION));
  if (span) {
    const lastOpen = text.lastIndexOf(span.open, cut - 1);
    if (lastOpen >= 0) {
      const lastClose = text.lastIndexOf(span.close, cut - 1);
      if (lastOpen > lastClose && lastOpen >= floor) cut = lastOpen;
    }
  }
  for (const marker of MARKERS) {
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

function openingLine(piece: string, previous: string): string {
  const at = piece.lastIndexOf(FENCE);
  if (at < 0) return previous;
  const end = piece.indexOf("\n", at);
  return piece.slice(at, end < 0 ? undefined : end).trimEnd();
}

export function splitFenced(text: string, max: number, options: ChunkOptions): string[] {
  const chunks: string[] = [];
  let rest = text;
  let inFence = false;
  let opener = FENCE;
  for (;;) {
    const info = options.keepFenceInfo && opener.length <= max / MAX_REOPEN_FENCE_DIVISOR ? opener : FENCE;
    const prefix = inFence ? `${info}\n` : "";
    if (prefix.length + rest.length <= max) {
      chunks.push(prefix + rest);
      break;
    }
    const fenceMachineryFits = max >= MIN_FENCE_SPLIT_BUDGET;
    if (!fenceMachineryFits || (!inFence && !rest.slice(0, max + FENCE.length).includes(FENCE))) {
      const cut = options.cutAt(rest, max);
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
      continue;
    }
    const budget = Math.max(1, max - prefix.length - FENCE_CLOSE.length);
    const cut = fenceCutIndex(rest, budget);
    const head = rest.slice(0, cut);
    const openAtCut: boolean = inFence !== (countFenceTokens(head) % 2 === 1);
    chunks.push(prefix + (openAtCut ? head.replace(/\n$/, "") + FENCE_CLOSE : head));
    if (openAtCut) opener = openingLine(head, opener);
    rest = rest.slice(cut);
    inFence = openAtCut;
  }
  return chunks;
}
