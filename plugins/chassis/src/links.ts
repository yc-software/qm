export type LinkSegment = { kind: "text"; text: string } | { kind: "link"; href: string };

const URL_RE = /https?:\/\/[^\s<>"']+/g;

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

function trimTrailing(url: string): string {
  const unmatched: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  for (const ch of url) {
    if (ch in unmatched) unmatched[ch]! += 1;
    if (ch in CLOSERS) unmatched[CLOSERS[ch]!]! -= 1;
  }
  let end = url.length;
  for (; end > 0; end--) {
    const last = url[end - 1]!;
    if (".,;:!?\u201c\u201d\u2018\u2019\u00ab\u00bb\u2026".includes(last)) continue;
    if (!((unmatched[last] ?? 0) > 0)) break;
    unmatched[last]! -= 1;
  }
  return url.slice(0, end);
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
