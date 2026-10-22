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

function fenceRun(line: string): string | undefined {
  let indent = 0;
  while (indent < 3 && line[indent] === " ") indent++;
  const mark = line[indent];
  if (mark !== "`" && mark !== "~") return undefined;
  let run = indent;
  while (line[run] === mark) run++;
  return run - indent >= 3 ? line.slice(indent, run) : undefined;
}

function closesFence(line: string, opener: string): boolean {
  const run = fenceRun(line);
  return !!run && run[0] === opener[0] && run.length >= opener.length && line.trim() === run;
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

export function absoluteAppLinks(text: string, baseUrl: string | undefined): string {
  if (!baseUrl) return text;
  let fence: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      if (fence) {
        if (closesFence(line, fence)) fence = undefined;
        return line;
      }
      fence = fenceRun(line);
      return fence ? line : rewriteOutsideCodeSpans(line, baseUrl);
    })
    .join("\n");
}
