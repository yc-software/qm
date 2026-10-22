export function headSlice(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function tailSlice(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  const cut = s.slice(-n);
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
}

export function jsonbSafeStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_ALL = new RegExp(LONE_SURROGATE, "g");

export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}

export function pgTextSafe(s: string): string {
  let out = s;
  if (out.includes("\u0000")) out = out.replaceAll("\u0000", "");
  if (hasLoneSurrogate(out)) out = out.replace(LONE_SURROGATE_ALL, "\uFFFD");
  return out;
}

export function outermostJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end < start ? undefined : text.slice(start, end + 1);
}

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

function rewriteAppLinks(segment: string, baseUrl: string): string {
  return segment.replace(APP_LINK, (_m, label: string, path: string) => `[${label}](${new URL(path, baseUrl).href})`);
}

function rewriteOutsideCodeSpans(line: string, baseUrl: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const tick = line.indexOf("`", i);
    if (tick === -1) return out + rewriteAppLinks(line.slice(i), baseUrl);
    let run = tick + 1;
    while (line[run] === "`") run++;
    const close = line.indexOf(line.slice(tick, run), run);
    const end = close === -1 ? run : close + run - tick;
    out += rewriteAppLinks(line.slice(i, tick), baseUrl) + line.slice(tick, end);
    i = end;
  }
}

function rewriteProse(prose: string, baseUrl: string): string {
  return prose
    .split("\n")
    .map((line) => rewriteOutsideCodeSpans(line, baseUrl))
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
