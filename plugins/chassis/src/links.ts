export type LinkSegment = { kind: "text"; text: string } | { kind: "link"; href: string };

const URL_RE = /https?:\/\/[^\s<>"']+/g;

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (text: string, ch: string): number => text.split(ch).length - 1;

function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    const opener = CLOSERS[last];
    const unbalanced = opener !== undefined && count(out, opener) < count(out, last);
    if (!".,;:!?\u201c\u201d\u2018\u2019\u00ab\u00bb\u2026".includes(last) && !unbalanced) return out;
    out = out.slice(0, -1);
  }
}

export function splitLinks(text: string): LinkSegment[] {
  const segments: LinkSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0];
    const href = trimTrailing(raw);
    if (!href) continue;
    const start = match.index;
    if (start > cursor) segments.push({ kind: "text", text: text.slice(cursor, start) });
    segments.push({ kind: "link", href });
    cursor = start + href.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
