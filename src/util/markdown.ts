const APP_LINK = /\[([^[\]\n]+)\]\((\/d\/[^\s)[]+)\)/g;

export interface FencedCodeBlock {
  start: number;
  end: number;
  body: string;
}

function fenceRun(line: string): string | undefined {
  let indent = 0;
  while (indent < 3 && line[indent] === " ") indent++;
  const mark = line[indent];
  if (mark !== "`" && mark !== "~") return undefined;
  let run = indent;
  while (line[run] === mark) run++;
  if (run - indent < 3 || (mark === "`" && line.includes("`", run))) return undefined;
  return line.slice(indent, run);
}

export function fencedCodeBlocks(text: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  let open: { start: number; run: string; bodyStart: number } | undefined;
  let offset = 0;
  for (const line of text.split("\n")) {
    const next = offset + line.length + 1;
    const run = fenceRun(line);
    if (!open) {
      if (run) open = { start: offset, run, bodyStart: next };
    } else if (run && run[0] === open.run[0] && run.length >= open.run.length && line.trim() === run) {
      blocks.push({ start: open.start, end: offset + line.length, body: text.slice(open.bodyStart, offset) });
      open = undefined;
    }
    offset = next;
  }
  if (open) {
    blocks.push({ start: open.start, end: text.length, body: text.slice(Math.min(open.bodyStart, text.length)) });
  }
  return blocks;
}

function codeSpans(line: string): Array<[number, number]> {
  const runs: Array<{ start: number; end: number }> = [];
  const byLength = new Map<number, number[]>();
  for (let tick = line.indexOf("`"); tick !== -1; tick = line.indexOf("`", runs.at(-1)!.end)) {
    let end = tick + 1;
    while (line[end] === "`") end++;
    const peers = byLength.get(end - tick) ?? [];
    peers.push(runs.length);
    byLength.set(end - tick, peers);
    runs.push({ start: tick, end });
  }
  const spans: Array<[number, number]> = [];
  const cursors = new Map<number, number>();
  for (let i = 0; i < runs.length; i++) {
    const length = runs[i]!.end - runs[i]!.start;
    const peers = byLength.get(length)!;
    let cursor = cursors.get(length) ?? 0;
    while (cursor < peers.length && peers[cursor]! <= i) cursor++;
    cursors.set(length, cursor);
    if (cursor < peers.length) {
      const close = peers[cursor]!;
      spans.push([runs[i]!.start, runs[close]!.end]);
      i = close;
    }
  }
  return spans;
}

function rewriteLine(line: string, baseUrl: string): string {
  const spans = codeSpans(line);
  let next = 0;
  return line.replace(APP_LINK, (match: string, label: string, path: string, index: number) => {
    while (next < spans.length && spans[next]![1] <= index) next++;
    const inSpan = next < spans.length && spans[next]![0] <= index;
    return inSpan ? match : `[${label}](${new URL(path, baseUrl).href})`;
  });
}

function rewriteProse(prose: string, baseUrl: string): string {
  return prose
    .split("\n")
    .map((line) => rewriteLine(line, baseUrl))
    .join("\n");
}

export function absoluteAppLinks(text: string, baseUrl: string | undefined): string {
  if (!baseUrl) return text;
  let out = "";
  let cursor = 0;
  for (const block of fencedCodeBlocks(text)) {
    out += rewriteProse(text.slice(cursor, block.start), baseUrl) + text.slice(block.start, block.end);
    cursor = block.end;
  }
  return out + rewriteProse(text.slice(cursor), baseUrl);
}
