const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface MarkdownFence {
  marker: "`" | "~";
  length: number;
  info: string;
}

export function markdownFence(line: string): MarkdownFence | null {
  const match = FENCE_LINE.exec(line);
  const run = match?.[1];
  const suffix = match?.[2] ?? "";
  if (!run || (run.startsWith("`") && suffix.includes("`"))) return null;
  return {
    marker: run.charAt(0) as MarkdownFence["marker"],
    length: run.length,
    info: suffix.trim(),
  };
}

export function fenceDelimiter(line: string): string | null {
  return markdownFence(line)?.marker ?? null;
}

export function stableSplitPoint(text: string): number {
  let inFence = false;
  let fenceChar = "";
  let mathDelims = 0;
  let lastSafe = 0;
  let pos = 0;
  let prevIndented = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineStart = pos;
    pos += line.length + 1;
    const fence = fenceDelimiter(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence;
      } else if (fence === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    mathDelims += (line.match(/\$\$/g) ?? []).length;
    if (line.trim() !== "") {
      prevIndented = /^(?: {4}|\t)/.test(line);
      continue;
    }
    if (i === lines.length - 1) continue;
    if (lineStart === 0 || mathDelims % 2 !== 0) continue;
    if (prevIndented) {
      let next: string | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j] ?? "";
        if (candidate.trim() !== "") {
          next = candidate;
          break;
        }
      }
      if (next === null || /^(?: {4}|\t)/.test(next)) continue;
    }
    lastSafe = Math.min(pos, text.length);
  }
  return lastSafe;
}

const SEGMENT_QUANTUM = 2048;

export function splitStreamingMarkdown(
  text: string,
  quantum: number = SEGMENT_QUANTUM,
): { segments: string[]; tail: string } {
  const segments: string[] = [];
  let segStart = 0;
  for (;;) {
    const rest = text.slice(segStart);
    if (rest.length < quantum) break;
    const at = firstSafeBoundaryAtOrAfter(rest, quantum);
    if (at <= 0) break;
    segments.push(text.slice(segStart, segStart + at));
    segStart += at;
  }
  return { segments, tail: text.slice(segStart) };
}

function firstSafeBoundaryAtOrAfter(text: string, min: number): number {
  let inFence = false;
  let fenceChar = "";
  let mathDelims = 0;
  let pos = 0;
  let prevIndented = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineStart = pos;
    pos += line.length + 1;
    const fence = fenceDelimiter(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence;
      } else if (fence === fenceChar) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    mathDelims += (line.match(/\$\$/g) ?? []).length;
    if (line.trim() !== "") {
      prevIndented = /^(?: {4}|\t)/.test(line);
      continue;
    }
    if (i === lines.length - 1) continue;
    if (lineStart === 0 || mathDelims % 2 !== 0) continue;
    if (prevIndented) {
      let next: string | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j] ?? "";
        if (candidate.trim() !== "") {
          next = candidate;
          break;
        }
      }
      if (next === null || /^(?: {4}|\t)/.test(next)) continue;
    }
    const at = Math.min(pos, text.length);
    if (at >= min) return at;
  }
  return 0;
}
